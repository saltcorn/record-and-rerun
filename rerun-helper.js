const {
  parseDataField,
  createTestDirName,
  preparePlaywrightDir,
  runPlaywrightScript,
  copyHtmlReport,
  readBenchmarkFiles,
  calcStats,
} = require("./common");
const Table = require("@saltcorn/data/models/table");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { getState } = require("@saltcorn/data/db/state");

/**
 * Helper class to rerun a recorded user workflow
 */
class RerunHelper {
  constructor(
    wfTable,
    wfRow,
    wfRunRel,
    {
      num_iterations,
      workflow_name_field,
      data_field,
      success_flag_field,
      benchmark_data_field,
      html_report_file,
      html_report_directory,
    },
  ) {
    this.wfTable = wfTable;
    this.wfRow = wfRow;
    this.wfRunRel = wfRunRel;
    this.dataRel = parseDataField(data_field);
    this.isBenchmark = !!benchmark_data_field;
    this.numIterations = num_iterations || 1;
    this.workflowName = wfRow[workflow_name_field].replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    this.testDir = createTestDirName(this.workflowName);
    if (this.isBenchmark) this.benchDataField = benchmark_data_field;
    this.htmlReportFile = html_report_file;
    this.successFlagField = success_flag_field;
    this.htmlReportDir = html_report_directory || "/";
  }

  async rerun(wfRunId) {
    const wfRunRow = this.wfRunRel
      ? {
          [this.wfRunRel.topFk]: this.wfRow[this.wfTable.pk_name || "id"],
        }
      : null;
    let successFlag = true;
    try {
      await preparePlaywrightDir(
        this.testDir,
        this.workflowName,
        await this.loadEvents(),
      );
      await runPlaywrightScript(
        this.testDir,
        this.numIterations,
        this.isBenchmark,
      );

      if (wfRunRow) {
        // prepare wfRun-update
        if (this.successFlagField)
          wfRunRow[this.successFlagField] = successFlag;
        if (this.isBenchmark) {
          const allRunStats = await readBenchmarkFiles(this.testDir);
          const benchJson = calcStats(allRunStats);
          wfRunRow[this.benchDataField] = benchJson;
        }
        await this.handleReport(wfRunRow);
      }
    } catch (err) {
      getState().log(2, `Workflow rerun error: ${err.message}`);
      await this.handleReport(wfRunRow);
      successFlag = false;
      if (wfRunRow && this.successFlagField)
        wfRunRow[this.successFlagField] = successFlag;
    } finally {
      if (this.wfRunRel && wfRunId) {
        const wfRunTbl = Table.findOne({ name: this.wfRunRel.tblName });
        await wfRunTbl.updateRow(wfRunRow, wfRunId);
      }
    }
    return successFlag;
  }

  async handleReport(wfRunRow) {
    try {
      if (this.htmlReportFile && this.htmlReportDir) {
        const pathToServe = await copyHtmlReport(
          this.testDir,
          this.workflowName,
          this.htmlReportDir,
        );
        wfRunRow[this.htmlReportFile] = pathToServe;
      }
    } catch (err) {
      getState().log(2, `Unable to copy HTML report: ${err.message}`);
    }
  }

  async loadEvents() {
    const { dataTblName, topFk, dataField } = this.dataRel;
    const dataTbl = Table.findOne({ name: dataTblName });
    if (!dataTbl) throw new Error("Data table not found");
    const rows = await dataTbl.getRows({ [topFk]: this.wfRow.id });
    return rows.map((r) => r[dataField]);
  }
}

module.exports = {
  RerunHelper,
};
