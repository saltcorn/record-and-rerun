const {
  cfgOpts,
  parseDataField,
  parseRelation,
  createTestDirName,
  preparePlaywrightDir,
  runPlaywrightScript,
  copyHtmlReport,
  readBenchmarkFiles,
  calcStats,
  insertWfRunRow,
} = require("./common");
const Table = require("@saltcorn/data/models/table");
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
    this.htmlReportDir = html_report_directory;
  }

  async rerun(wfRunId) {
    const wfRunRow = {
      [this.wfRunRel.topFk]: this.wfRow[this.wfTable.pk_name || "id"],
    };
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

      // prepare wfRun-update
      wfRunRow[this.successFlagField] = true;
      if (this.isBenchmark) {
        const allRunStats = await readBenchmarkFiles(this.testDir);
        const benchJson = await calcStats(allRunStats);
        wfRunRow[this.benchDataField] = benchJson;
      }
      if (this.htmlReportFile && this.htmlReportDir) {
        const pathToServe = await copyHtmlReport(
          this.testDir,
          this.workflowName,
          this.htmlReportDir,
        );
        wfRunRow[this.htmlReportFile] = pathToServe;
      }
    } catch (err) {
      getState().log(2, `Workflow rerun error: ${err.message}`);
      wfRunRow[this.successFlagField] = false;
    } finally {
      const wfRunTbl = Table.findOne({ name: this.wfRunRel.tblName });
      await wfRunTbl.updateRow(wfRunRow, wfRunId);
    }
    return wfRunRow[this.successFlagField];
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
  rerun_user_workflow: {
    description: "Rerun a recorded user workflow",
    configFields: async ({ table }) => {
      const {
        nameOpts,
        dataOpts,
        fileOpts,
        directoryOpts,
        wfRunRelOpts,
        successFlagOpts,
      } = await cfgOpts(table.id);
      return [
        {
          name: "workflow_name_field",
          label: "Workflow Name",
          type: "String",
          required: true,
          attributes: {
            options: nameOpts.map((f) => f.name).join(),
          },
          required: true,
        },
        {
          name: "data_field",
          label: "Event Data Field",
          sublabel:
            "JSON Field to store recorded events (format table_with_data.json_field->key_to_top_table)",
          type: "String",
          attributes: {
            options: dataOpts.map((f) => f).join(),
          },
          required: true,
        },
        {
          name: "workflow_run_relation",
          label: "Workflow Run Relation",
          type: "String",
          sublabel:
            "This relation points to a child-table to store re-run results (format: results_table.key_to_top_table)",
          attributes: {
            options: wfRunRelOpts,
          },
          required: true,
        },
        {
          name: "success_flag_field",
          label: "Success Flag Field",
          type: "String",
          sublabel: "Boolean field to indicate if a re-run run was successful",
          attributes: {
            calcOptions: ["workflow_run_relation", successFlagOpts],
          },
          required: true,
        },
        {
          name: "html_report_file",
          label: "HTML Report File Field",
          type: "String",
          sublabel: "File field to store HTML report (optional)",
          attributes: {
            calcOptions: ["workflow_run_relation", fileOpts],
          },
        },
        {
          name: "html_report_directory",
          label: "HTML Report Directory",
          type: "String",
          sublabel: "Directory to store HTML reports",
          attributes: {
            options: directoryOpts,
          },
        },
      ];
    },
    run: async ({ table, row, configuration, req }) => {
      const wfRunRel = parseRelation(configuration.workflow_run_relation);
      const wfRunId = await insertWfRunRow(
        row[table.pk_name || "id"],
        wfRunRel,
      );
      if (typeof wfRunId === "string") throw new Error(wfRunId);
      const helper = new RerunHelper(table, row, wfRunRel, configuration);
      const success = await helper.rerun(wfRunId);
      const msg = `Workflow re-run completed: ${success ? "success" : "failed"}`;
      getState().log(5, msg);
      return {
        notify: msg,
      };
    },
    requireRow: true,
    supportsAsync: true,
  },

  benchmark_user_workflow: {
    description: "Benchmark a recorded user workflow",
    configFields: async ({ table }) => {
      const {
        nameOpts,
        dataOpts,
        wfRunRelOpts,
        successFlagOpts,
        benchDataOpts,
      } = await cfgOpts(table.id);
      return [
        {
          name: "num_iterations",
          label: "Number of Iterations",
          type: "Integer",
          default: 5,
          required: true,
        },
        {
          name: "workflow_name_field",
          label: "Workflow Name",
          type: "String",
          required: true,
          attributes: {
            options: nameOpts,
          },
          required: true,
        },
        {
          name: "data_field",
          label: "Event Data Field",
          sublabel:
            "JSON Field to store recorded events (format table_with_data.json_field->key_to_top_table)",
          type: "String",
          attributes: {
            options: dataOpts,
          },
          required: true,
        },
        {
          name: "workflow_run_relation",
          label: "Workflow Run Relation",
          type: "String",
          sublabel:
            "This relation points to a child-table to store re-run results (format: results_table.key_to_top_table)",
          attributes: {
            options: wfRunRelOpts,
          },
          required: true,
        },
        {
          name: "benchmark_data_field",
          label: "Benchmark Data Field",
          sublabel: "JSON field to store benchmark results",
          type: "String",
          attributes: {
            calcOptions: ["workflow_run_relation", benchDataOpts],
          },
          required: true,
        },
        {
          name: "success_flag_field",
          label: "Success Flag Field",
          type: "String",
          sublabel: "Boolean field to indicate if a re-run run was successful",
          attributes: {
            calcOptions: ["workflow_run_relation", successFlagOpts],
          },
          required: true,
        },
      ];
    },
    run: async ({ table, row, configuration, req }) => {
      const wfRunRel = parseRelation(configuration.workflow_run_relation);
      const wfRunId = await insertWfRunRow(
        row[table.pk_name || "id"],
        wfRunRel,
      );
      if (typeof wfRunId === "string") throw new Error(wfRunId);
      const helper = new RerunHelper(table, row, wfRunRel, configuration);
      const success = await helper.rerun(wfRunId);
      const msg = `Workflow benchmark completed: ${success ? "success" : "failed"}`;
      getState().log(5, msg);
      return {
        notify: msg,
      };
    },
    requireRow: true,
    supportsAsync: true,
  },
};
