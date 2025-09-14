const {
  cfgOpts,
  parseDataField,
  createTestDirName,
  preparePlaywrightDir,
  runPlaywrightScript,
  copyHtmlReport,
  readBenchmarkFiles,
  calcStats,
} = require("./common");
const Table = require("@saltcorn/data/models/table");

/**
 * Helper class to rerun a recorded user workflow
 */
class RerunHelper {
  constructor(
    table,
    row,
    {
      num_iterations,
      workflow_name_field,
      data_field,
      html_report_file,
      html_report_directory,
      benchmark_data_field,
    },
  ) {
    this.wfTable = table;
    this.row = row;
    this.dataTblRel = parseDataField(data_field);
    this.isBenchmark = !!benchmark_data_field;
    this.benchmarkRel = this.isBenchmark
      ? parseDataField(benchmark_data_field)
      : undefined;
    this.numIterations = num_iterations || 1;
    this.workflowName = row[workflow_name_field].replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    this.testDir = createTestDirName(this.workflowName);
    this.htmlReportFile = html_report_file;
    this.htmlReportDir = html_report_directory;
  }

  async rerun() {
    await preparePlaywrightDir(
      this.testDir,
      this.workflowName,
      await this.loadEvents(),
    );
    await runPlaywrightScript(
      this.testDir,
      this.numIterations,
      this.benchmarkRel,
    );
    if (this.htmlReportFile && this.htmlReportDir) {
      const pathToServe = await copyHtmlReport(
        this.testDir,
        this.workflowName,
        this.htmlReportDir,
      );
      await this.wfTable.updateRow(
        { [this.htmlReportFile]: pathToServe },
        this.row[this.wfTable.pk_name],
      );
    }
    if (this.benchmarkRel) {
      const allRunStats = await readBenchmarkFiles(this.testDir);
      const benchJson = await calcStats(allRunStats);
      const { dataTblName, topFk, dataField } = this.benchmarkRel;
      const dataTbl = Table.findOne({ name: dataTblName });
      if (!dataTbl) throw new Error("Benchmark data table not found");
      const benchRow = {
        [topFk]: this.row.id,
        [dataField]: benchJson,
      };
      await dataTbl.insertRow(benchRow);
    }
  }

  async loadEvents() {
    const { dataTblName, topFk, dataField } = this.dataTblRel;
    const dataTbl = Table.findOne({ name: dataTblName });
    if (!dataTbl) throw new Error("Data table not found");
    const rows = await dataTbl.getRows({ [topFk]: this.row.id });
    return rows.map((r) => r[dataField]);
  }
}

module.exports = {
  rerun_user_workflow: {
    description: "Rerun a recorded user workflow",
    configFields: async ({ table }) => {
      const { nameOpts, dataOpts, fileOpts, directoryOpts } = await cfgOpts(
        table.id,
      );
      return [
        {
          name: "workflow_name_field",
          label: "Workflow Name",
          type: "String",
          required: true,
          attributes: {
            options: nameOpts.map((f) => f.name).join(),
          },
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
        },
        {
          name: "html_report_file",
          label: "HTML Report File Field",
          type: "String",
          sublabel: "File field to store HTML report (optional)",
          attributes: {
            options: fileOpts,
          },
        },
        {
          name: "html_report_directory",
          label: "HTML Report Directory",
          type: "String",
          sublabel: "Directory to store HTML reports",
          showIf: { html_report_file: fileOpts },
          attributes: {
            options: directoryOpts,
          },
        },
      ];
    },
    run: async ({ table, row, configuration }) => {
      const helper = new RerunHelper(table, row, configuration);
      await helper.rerun();
      return {
        success: true,
        notify_success: "The workflow completed successfully",
      };
    },
    requireRow: true,
  },

  benchmark_user_workflow: {
    description: "Benchmark a recorded user workflow",
    configFields: async ({ table }) => {
      const { nameOpts, dataOpts } = await cfgOpts(table.id);
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
        },
        {
          name: "benchmark_data_field",
          label: "Benchmark Data Field",
          type: "String",
          attributes: {
            options: dataOpts,
          },
        },
      ];
    },
    run: async ({ table, row, configuration }) => {
      const helper = new RerunHelper(table, row, configuration);
      await helper.rerun();
      return {
        success: true,
        notify_success: "The workflow completed successfully",
      };
    },
    requireRow: true,
  },
};
