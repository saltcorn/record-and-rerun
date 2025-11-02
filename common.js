/**
 * Common functions for the record-and-rerun plugin
 */
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const File = require("@saltcorn/data/models/file");
const Field = require("@saltcorn/data/models/field");
const Plugin = require("@saltcorn/data/models/plugin");
const db = require("@saltcorn/data/db");
const { getState } = require("@saltcorn/data/db/state");

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

const prepMobileEnvParams = (user) => {
  const builderSettings = getState().getConfig("mobile_builder_settings") || {};
  return {
    ENTRY_POINT: builderSettings.entryPoint,
    ENTRY_POINT_TYPE: builderSettings.entryPointType,
    SERVER_PATH: "http://localhost:3000", //builderSettings.serverURL,
    INCLUDED_PLUGINS: (builderSettings.includedPlugins || []).join(" "),
    USER: user.email,
  };
};

/**
 * run the playwright script in the test directory
 * @param {string} testDir
 * @param {number} numIterations
 * @param {boolean} isBenchmark
 * @param {string} workflowType Web or Mobile
 */
const runPlaywrightScript = async (
  testDir,
  numIterations,
  isBenchmark,
  workflowType,
  user,
) => {
  const child = spawn(
    path.join(
      testDir,
      `run_${workflowType === "Mobile" ? "mobile" : "web"}.bash`,
    ),
    {
      cwd: testDir,
      stdio: ["ignore", "pipe", "pipe"], // capture stdout/stderr
      env: {
        ...process.env,
        NUM_ITERATIONS: isBenchmark ? String(numIterations) : "1",
        DO_BENCHMARK: isBenchmark ? true : false,
        SCRIPT_DIR: testDir,
        ...(workflowType === "Mobile" ? prepMobileEnvParams(user) : {}),
      },
    },
  );
  await new Promise((resolve, reject) => {
    const state = getState();
    child.on("exit", async (code) => {
      if (code === 0) {
        state.log(5, "Playwright tests completed successfully");
        resolve();
      } else reject(new Error(`Playwright tests failed with code ${code}`));
    });
    child.on("error", (err) => {
      state.log(2, `Playwright process error: ${err.message}`);
      reject(err);
    });
    child.stdout.on("data", (data) => {
      state.log(5, data.toString().trim());
    });
    child.stderr.on("data", (data) => {
      state.log(2, data.toString().trim());
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
  let statsLength = allRunStats[0].length;
  for (let pointIndex = 0; pointIndex < statsLength; pointIndex++) {
    const element = {
      url: allRunStats[0][pointIndex].url,
      responseEnd: [],
      domComplete: [],
      LCP: [],
      correct: [],
    };

    const allMetrics = ["responseEnd", "domComplete", "LCP", "correct"];
    for (const runStats of allRunStats) {
      if (runStats[pointIndex].url !== element.url)
        throw new Error("Inconsistent urls in stats");
      for (const key of allMetrics) {
        element[key].push(runStats[pointIndex][key]);
      }
    }

    const resultEntry = { url: element.url };
    for (const key of ["responseEnd", "domComplete", "LCP"]) {
      resultEntry[`${key}_mean`] = calcMean(element[key]);
      resultEntry[`${key}_standard_deviation`] = calcStandardDeviation(
        element[key],
      );
    }
    resultEntry.correct = Math.round(calcMean(element.correct));
    result.push(resultEntry);
  }

  return result;
};

/*
 * If the plugin configuration still has an active recording ID, remove it
 */
const removeRecordingId = async (id, reload = false) => {
  let plugin = await Plugin.findOne({ name: "record-and-rerun" });
  if (!plugin) {
    plugin = await Plugin.findOne({
      name: "@saltcorn/record-and-rerun",
    });
  }

  if (plugin?.configuration?.active_recording_ids?.includes(id)) {
    plugin.configuration.active_recording_ids =
      plugin.configuration.active_recording_ids.filter((rid) => rid !== id);
    await plugin.upsert();
    if (reload) {
      getState().processSend({
        refresh_plugin_cfg: plugin.name,
        tenant: db.getTenantSchema(),
      });
    }
  }
};

const getTablesIfExists = async () => {
  const sessions = await Table.findOne({ name: "session_recordings" });
  const sessionEvents = await Table.findOne({ name: "session_events" });
  const sessionRuns = await Table.findOne({ name: "session_runs" });
  if (!sessions || !sessionEvents || !sessionRuns) return null;

  const eventDataField = sessionEvents.fields.find(
    (f) => f.type.name === "JSON",
  );
  const eventsToSessFk = sessionEvents
    .getForeignKeys()
    .find((fk) => fk.reftable_name === "session_recordings");

  const runResultsField = sessionRuns.fields.find(
    (f) => f.type.name === "JSON",
  );
  const resultsToSessFk = sessionRuns
    .getForeignKeys()
    .find((fk) => fk.reftable_name === "session_recordings");

  if (
    !eventDataField ||
    !eventsToSessFk ||
    !runResultsField ||
    !resultsToSessFk
  )
    return null;

  return { sessions, sessionEvents, sessionRuns };
};

const createTables = async () => {
  getState().log(5, "Creating session recording tables");
  // recordings table
  const sessions = await Table.create("session_recordings", {
    min_role_read: 1,
    min_role_write: 1,
  });
  await Field.create({
    table: sessions,
    name: "name",
    label: "Name",
    type: "String",
    required: true,
  });

  // events table
  const sessionEvents = await Table.create("session_events", {
    min_role_read: 1,
    min_role_write: 1,
  });
  await Field.create({
    table: sessionEvents,
    name: "session_recording",
    label: "Session Recording",
    type: "Key",
    reftable_name: "session_recordings",
    attributes: { summary_field: "name" },
    required: true,
  });
  await Field.create({
    table: sessionEvents,
    name: "event_data",
    label: "Event Data",
    type: "JSON",
    required: true,
  });

  // runs table
  const sessionRuns = await Table.create("session_runs", {
    min_role_read: 1,
    min_role_write: 1,
  });
  await Field.create({
    table: sessionRuns,
    name: "session_recording",
    label: "Session Recording",
    type: "Key",
    reftable_name: "session_recordings",
    attributes: { summary_field: "name" },
    required: true,
  });
  await Field.create({
    table: sessionRuns,
    name: "success",
    label: "Success",
    type: "Bool",
    required: false,
  });
  await Field.create({
    table: sessionRuns,
    name: "benchmark_results",
    label: "Benchmark Results",
    type: "JSON",
    required: false,
  });
  await Field.create({
    table: sessionRuns,
    name: "html_report",
    label: "HTML Report",
    type: "File",
    required: false,
  });

  return { sessions, sessionEvents, sessionRuns };
};

const getExistingViews = async ({ sessions, sessionEvents, sessionRuns }) => {
  const recorderView = await View.findOne({
    name: "Sessions Recorder",
    table_id: sessions.id,
    viewtemplate: "RecordEvents",
  });
  const sessionEventsListView = await View.findOne({
    name: "Session Events List",
    table_id: sessionEvents.id,
    viewtemplate: "List",
  });
  const sessionsListView = await View.findOne({
    name: "Sessions List",
    table_id: sessions.id,
    viewtemplate: "List",
  });
  const sessionRunsListView = await View.findOne({
    name: "Session Runs List",
    table_id: sessionRuns.id,
    viewtemplate: "List",
  });
  const benchmarkRunsListView = await View.findOne({
    name: "Session Benchmark Runs List",
    table_id: sessionRuns.id,
    viewtemplate: "List",
  });

  return {
    recorderView,
    sessionEventsListView,
    sessionsListView,
    sessionRunsListView,
    benchmarkRunsListView,
    allViewsExist:
      recorderView &&
      sessionEventsListView &&
      sessionsListView &&
      sessionRunsListView &&
      benchmarkRunsListView,
  };
};

const createViews = async (
  { sessions, sessionEvents, sessionRuns },
  {
    recorderView,
    sessionEventsListView,
    sessionsListView,
    sessionRunsListView,
    benchmarkRunsListView,
  },
) => {
  getState().log(5, "Creating session recording views");
  // recorder view ('Sessions Recorder')
  if (!recorderView) {
    await View.create({
      name: "Sessions Recorder",
      viewtemplate: "RecordEvents",
      table_id: sessions.id,
      configuration: {
        data_field: "session_events.event_data->session_recording",
        workflow_name_field: "name",
        confirm_start_recording: true,
      },
      min_role: 1,
    });
  }

  // list of events ('Session Events List')
  if (!sessionEventsListView) {
    await View.create({
      name: "Session Events List",
      viewtemplate: "List",
      table_id: sessionEvents.id,
      configuration: {
        layout: {
          besides: [
            {
              contents: {
                type: "JoinField",
                fieldview: "as_text",
                join_field: "session_recording.name",
                configuration: {},
              },
              header_label: "Session Recording",
            },
            {
              contents: {
                type: "field",
                fieldview: "show",
                field_name: "event_data",
                configuration: {
                  fieldview: "as_json",
                  field_name: "event_data",
                  configuration: {},
                },
              },
              header_label: "Event Data",
            },
          ],
          list_columns: true,
        },
        columns: [
          {
            type: "JoinField",
            fieldview: "as_text",
            join_field: "session_recording.name",
            configuration: {},
          },
          {
            type: "Field",
            fieldview: "show",
            field_name: "event_data",
            configuration: {
              fieldview: "as_json",
              field_name: "event_data",
              configuration: {},
            },
          },
        ],
      },
      min_role: 1,
    });
  }

  // list of recordings with actions to rerun or benchmark ('Sessions List')
  if (!sessionsListView) {
    await View.create({
      name: "Sessions List",
      viewtemplate: "List",
      table_id: sessions.id,
      configuration: {
        layout: {
          besides: [
            {
              contents: {
                type: "field",
                fieldview: "as_text",
                field_name: "name",
                configuration: {},
              },
              header_label: "name",
            },
            {
              contents: {
                type: "action",
                block: false,
                rndid: "aaedc",
                nsteps: 1,
                confirm: false,
                minRole: 1,
                spinner: true,
                isFormula: {},
                run_async: false,
                action_icon: "",
                action_name: "rerun_user_workflow",
                action_size: "",
                action_bgcol: "",
                action_class: "",
                action_label: "",
                action_style: "btn-primary",
                action_title: "",
                configuration: {
                  data_field: "session_events.event_data->session_recording",
                  html_report_file: "html_report",
                  success_flag_field: "success",
                  workflow_name_field: "name",
                  html_report_directory: "",
                  workflow_run_relation: "session_runs.session_recording",
                },
                step_only_ifs: "",
                action_textcol: "",
                action_bordercol: "",
                step_action_names: "",
              },
              alignment: "Default",
              col_width_units: "px",
            },
            {
              contents: {
                type: "action",
                block: false,
                rndid: "7faf36",
                nsteps: 1,
                confirm: false,
                minRole: 1,
                spinner: true,
                isFormula: {},
                action_icon: "",
                action_name: "benchmark_user_workflow",
                action_label: "",
                configuration: {
                  data_field: "session_events.event_data->session_recording",
                  num_iterations: 5,
                  success_flag_field: "success",
                  workflow_name_field: "name",
                  benchmark_data_field: "benchmark_results",
                  workflow_run_relation: "session_runs.session_recording",
                },
              },
              alignment: "Default",
              col_width_units: "px",
            },
          ],
          list_columns: true,
        },
        columns: [
          {
            type: "Field",
            fieldview: "as_text",
            field_name: "name",
            configuration: {},
          },
          {
            type: "Action",
            rndid: "aaedc",
            nsteps: 1,
            confirm: false,
            minRole: 1,
            spinner: true,
            isFormula: {},
            run_async: false,
            action_icon: "",
            action_name: "rerun_user_workflow",
            action_size: "",
            action_bgcol: "",
            action_class: "",
            action_label: "",
            action_style: "btn-primary",
            action_title: "",
            configuration: {
              data_field: "session_events.event_data->session_recording",
              html_report_file: "html_report",
              success_flag_field: "success",
              workflow_name_field: "name",
              html_report_directory: "",
              workflow_run_relation: "session_runs.session_recording",
            },
            step_only_ifs: "",
            action_textcol: "",
            action_bordercol: "",
            step_action_names: "",
          },

          {
            type: "Action",
            rndid: "7faf36",
            nsteps: 1,
            confirm: false,
            minRole: 1,
            spinner: true,
            isFormula: {},
            run_async: false,
            action_icon: "",
            action_name: "benchmark_user_workflow",
            action_size: "",
            action_bgcol: "",
            action_class: "",
            action_label: "",
            action_style: "btn-primary",
            action_title: "",
            configuration: {
              data_field: "session_events.event_data->session_recording",
              num_iterations: 5,
              success_flag_field: "success",
              workflow_name_field: "name",
              benchmark_data_field: "benchmark_results",
              workflow_run_relation: "session_runs.session_recording",
            },
            step_only_ifs: "",
            action_textcol: "",
            action_bordercol: "",
            step_action_names: "",
          },
        ],
      },
      min_role: 1,
    });
  }

  // list of reruns with success flag and report link ('Session Runs List')
  if (!sessionRunsListView) {
    await View.create({
      name: "Session Runs List",
      description: "List of session rerun results (benchmarks excluded)",
      viewtemplate: "List",
      table_id: sessionRuns.id,
      configuration: {
        layout: {
          besides: [
            {
              contents: {
                type: "join_field",
                block: false,
                fieldview: "as_text",
                textStyle: "",
                join_field: "session_recording.name",
                configuration: {},
              },
              header_label: "Session Recording",
            },
            {
              contents: {
                type: "field",
                fieldview: "show",
                field_name: "success",
                configuration: {},
              },
              header_label: "Success",
            },
            {
              contents: {
                type: "field",
                fieldview: "Download link",
                field_name: "report",
                configuration: { button_style: " " },
              },
              header_label: "Report",
            },
            {
              contents: {
                type: "field",
                block: false,
                fieldview: "Download link",
                textStyle: "",
                field_name: "html_report",
                configuration: {
                  button_style: " ",
                },
              },
              alignment: "Default",
              header_label: "Report",
              col_width_units: "px",
            },
          ],
          list_columns: true,
        },
        columns: [
          {
            type: "JoinField",
            fieldview: "as_text",
            join_field: "session_recording.name",
            configuration: {},
          },
          {
            type: "Field",
            fieldview: "show",
            field_name: "success",
            configuration: {},
          },
          {
            type: "Field",
            fieldview: "Download link",
            field_name: "report",
            configuration: {
              button_style: " ",
            },
          },
          {
            type: "Field",
            block: false,
            fieldview: "Download link",
            textStyle: "",
            field_name: "html_report",
            configuration: {
              button_style: " ",
            },
          },
        ],
        default_state: {
          include_fml: "benchmark_results === null",
        },
      },
      min_role: 1,
    });
  }

  // list of benchmarks to see the stats ('Session Benchmark Runs List')
  if (!benchmarkRunsListView) {
    await View.create({
      name: "Session Benchmark Runs List",
      description: "List of session benchmark results (reruns excluded)",
      viewtemplate: "List",
      table_id: sessionRuns.id,
      configuration: {
        layout: {
          besides: [
            {
              contents: {
                type: "join_field",
                block: false,
                fieldview: "as_text",
                textStyle: "",
                join_field: "session_recording.name",
                configuration: {},
              },
              header_label: "Session Recording",
            },
            {
              contents: {
                type: "Field",
                fieldview: "show",
                field_name: "success",
                configuration: {},
              },
            },
            {
              contents: {
                type: "field",
                fieldview: "show",
                field_name: "benchmark_results",
                configuration: {
                  fieldview: "as_json",
                  field_name: "benchmark_results",
                  configuration: {},
                },
              },
              header_label: "Benchmark Results",
            },
          ],
          list_columns: true,
        },
        columns: [
          {
            type: "JoinField",
            block: false,
            fieldview: "as_text",
            textStyle: "",
            join_field: "session_recording.name",
            configuration: {},
          },
          {
            type: "Field",
            fieldview: "show",
            field_name: "success",
            configuration: {},
          },
          {
            type: "Field",
            fieldview: "show",
            field_name: "benchmark_results",
            configuration: {
              fieldview: "as_json",
              field_name: "benchmark_results",
              configuration: {},
            },
          },
        ],
        default_state: {
          include_fml: "benchmark_results !== null",
        },
      },
      min_role: 1,
    });
  }
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
  removeRecordingId,
  readBenchmarkFiles,
  insertWfRunRow,
  createTables,
  createViews,
  getTablesIfExists,
  getExistingViews,
};
