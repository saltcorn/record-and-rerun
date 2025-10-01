/**
 * Common functions for the record-and-rerun plugin
 */
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const Field = require("@saltcorn/data/models/field");
const db = require("@saltcorn/data/db");

const path = require("path");
const fs = require("fs").promises;
const { spawn } = require("child_process");

/**
 * Build options for the workflow configuration form
 * @param {number} tableId id of the workflow table
 */
const cfgOpts = async (tableId) => {
  const table = Table.findOne({ id: tableId });
  const fields = table.fields;
  const nameOpts = fields.filter((f) => f.type?.name === "String");
  const workflowRefs = await Field.find({
    reftable_name: table.name,
  });

  // collect JSON, Bool, and File fields from all referenced tables
  // event-data, benchmark-data, success-flag, html-report-file
  const wfRunRelOpts = [];
  const benchDataOpts = {};
  const successFlagOpts = {};
  const fileOpts = {};
  const dataOpts = [];
  for (const ref of workflowRefs) {
    const refTable = Table.findOne({ id: ref.table_id });
    const jsonFields = refTable.fields.filter((f) => f.type?.name === "JSON");
    dataOpts.push(
      jsonFields.map((f) => `${refTable.name}.${f.name}->${ref.name}`),
    );

    const wfRunRelation = `${refTable.name}.${ref.name}`;
    wfRunRelOpts.push(wfRunRelation);
    benchDataOpts[wfRunRelation] = jsonFields.map((f) => f.name);
    successFlagOpts[wfRunRelation] = [
      "",
      ...refTable.fields
        .filter((f) => f.type?.name === "Bool")
        .map((f) => f.name),
    ];
    fileOpts[wfRunRelation] = refTable.fields
      .filter((f) => f.type === "File")
      .map((f) => f.name);
    fileOpts[wfRunRelation].unshift("");
  }

  const directoryOpts = (await File.find({ isDirectory: true })).map(
    (d) => d.path_to_serve,
  );

  return {
    nameOpts,
    dataOpts,
    wfRunRelOpts,
    benchDataOpts,
    successFlagOpts,
    fileOpts,
    directoryOpts,
  };
};

/**
 * parse event-data_field of the form ref_table.json_field->ref_field
 * @param {string} field
 */
const parseDataField = (field) => {
  const match = field.match(/^([^.]+)\.([^-]+)->(.+)$/);
  if (!match) {
    throw new Error(
      "data_field must be of the form ref_table.json_field->ref_field",
    );
  }
  const [, dataTblName, dataField, topFk] = match;
  return { dataTblName, dataField, topFk };
};

/**
 * parse a simple relation of the form table.fk_to_top
 * @param {string} relation
 */
const parseRelation = (relation) => {
  const tokens = relation.split(".");
  if (tokens.length !== 2)
    throw new Error("relation must be of the form table.fk_to_top");
  return { tblName: tokens[0], topFk: tokens[1] };
};

/**
 * helper to create a directory name where the workflow test will be run
 * @param {string} workflowName
 */
const createTestDirName = (workflowName) =>
  path.join(__dirname, "playwright", db.getTenantSchema(), workflowName);

/**
 * set up the playwright test directory with template and events.json
 * @param {string} testDir
 * @param {string} workflowName
 * @param {object[]} events
 */
const preparePlaywrightDir = async (testDir, workflowName, events) => {
  await fs.cp(path.join(__dirname, "playwright_template"), testDir, {
    recursive: true,
  });
  await fs.writeFile(
    path.join(testDir, "events.json"),
    JSON.stringify({ events, workflow_name: workflowName }),
  );
  const benchmarkDir = path.join(testDir, "benchmark_data");
  try {
    await fs.access(benchmarkDir);
    const files = await fs.readdir(benchmarkDir);
    for (const file of files) {
      await fs.unlink(path.join(benchmarkDir, file));
    }
  } catch (err) {
    await fs.mkdir(benchmarkDir, { recursive: true });
  }
};

/**
 * run the playwright script in the test directory
 * @param {string} testDir
 * @param {number} numIterations
 * @param {boolean} isBenchmark
 */
const runPlaywrightScript = async (testDir, numIterations, isBenchmark) => {
  const child = spawn(path.join(testDir, "run.sh"), {
    cwd: testDir,
    stdio: "inherit",
    env: {
      ...process.env,
      NUM_ITERATIONS: isBenchmark ? String(numIterations) : "1",
      DO_BENCHMARK: isBenchmark ? true : false,
    },
  });
  await new Promise((resolve, reject) => {
    child.on("exit", async (code) => {
      if (code === 0) {
        resolve();
      } else reject(new Error(`Playwright tests failed with code ${code}`));
    });
    child.on("error", (err) => {
      reject(err);
    });
  });
};

/**
 * helper to insert a workflow-run row before running it
 * @param {id} workflowId
 * @param {object} wfRunTblRel
 */
const insertWfRunRow = async (workflowId, wfRunTblRel) => {
  const { tblName, topFk } = wfRunTblRel;
  const wfRunTbl = Table.findOne({ name: tblName });
  if (!wfRunTbl) throw new Error("Workflow run table not found");
  const wfRunRow = {
    [topFk]: workflowId,
  };
  const insRes = await wfRunTbl.insertRow(wfRunRow);
  return insRes;
};

/**
 * copy the HTML report to the selected directory and rename it
 * @param {string} testDir
 * @param {string} workflowName
 * @param {string} targetDir
 */
const copyHtmlReport = async (testDir, workflowName, targetDir) => {
  const reportFile = await File.from_file_on_disk(
    "index.html",
    path.join(testDir, "my-report"),
  );
  const newPath = File.get_new_path(
    path.join(targetDir || "/", `${workflowName}.html`),
    true,
  );
  const newName = path.basename(newPath);
  await reportFile.rename(newName);
  await reportFile.move_to_dir(targetDir || "/");
  return reportFile.path_to_serve;
};

/**
 * read all benchmark JSON files from the benchmark_data directory
 * and return an array of arrays of stats objects
 * @param {string} testDir
 */
const readBenchmarkFiles = async (testDir) => {
  const benchmarkDir = path.join(testDir, "benchmark_data");
  const files = await fs.readdir(benchmarkDir);
  const allRunStats = [];
  let statsLength = undefined;
  for (const file of files) {
    const runStats = JSON.parse(
      await fs.readFile(path.join(benchmarkDir, file), "utf8"),
    );
    if (!statsLength) statsLength = runStats.length;
    else if (statsLength !== runStats.length)
      throw new Error("Inconsistent number of stats entries");
    allRunStats.push(runStats);
  }
  return allRunStats;
};

const calcMean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

const calcStandardDeviation = (arr) => {
  const mean = calcMean(arr);
  const squareDiffs = arr.map((value) => {
    const diff = value - mean;
    return diff * diff;
  });
  const avgSquareDiff = calcMean(squareDiffs);
  return Math.sqrt(avgSquareDiff);
};

/**
 * calculate mean and standard deviation for each metric across all runs
 * @param {object[][]} allRunStats array of arrays of stats objects
 * @return {object[]} array of stats objects with mean and standard deviation
 */
const calcStats = (allRunStats) => {
  const result = [];
  const allMetrics = ["responseEnd", "domComplete", "LCP"];
  let statsLength = allRunStats[0].length;
  for (let pointIndex = 0; pointIndex < statsLength; pointIndex++) {
    const element = {
      url: allRunStats[0][pointIndex].url,
      responseEnd: [],
      domComplete: [],
      LCP: [],
    };

    for (const runStats of allRunStats) {
      if (runStats[pointIndex].url !== element.url)
        throw new Error("Inconsistent urls in stats");
      for (const key of allMetrics) {
        element[key].push(runStats[pointIndex][key]);
      }
    }

    const resultEntry = { url: element.url };
    for (const key of allMetrics) {
      resultEntry[`${key}_mean`] = calcMean(element[key]);
      resultEntry[`${key}_standard_deviation`] = calcStandardDeviation(
        element[key],
      );
    }
    result.push(resultEntry);
  }

  return result;
};

module.exports = {
  cfgOpts,
  parseDataField,
  parseRelation,
  createTestDirName,
  preparePlaywrightDir,
  runPlaywrightScript,
  copyHtmlReport,
  calcStats,
  readBenchmarkFiles,
  insertWfRunRow,
};
