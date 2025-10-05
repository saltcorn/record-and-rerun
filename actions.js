const { cfgOpts, parseRelation, insertWfRunRow } = require("./common");
const { RerunHelper } = require("./rerun-helper");
const Table = require("@saltcorn/data/models/table");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { getState } = require("@saltcorn/data/db/state");

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
            "This is an optional relation pointing to a child table that stores re-run results (format: results_table.key_to_top_table)",
          attributes: {
            options: wfRunRelOpts,
          },
        },
        {
          name: "success_flag_field",
          label: "Success Flag Field",
          type: "String",
          sublabel: "Boolean field to indicate if a re-run run was successful",
          attributes: {
            calcOptions: ["workflow_run_relation", successFlagOpts],
          },
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
      let wfRunId = null;
      let wfRunRel = null;
      if (configuration.workflow_run_relation) {
        wfRunRel = parseRelation(configuration.workflow_run_relation);
        wfRunId = await insertWfRunRow(row[table.pk_name || "id"], wfRunRel);
        if (typeof wfRunId === "string") throw new Error(wfRunId);
      }
      const helper = new RerunHelper(table, row, wfRunRel, configuration);
      const success = await helper.rerun(wfRunId);
      const msg = `Workflow re-run completed: ${
        success ? "success" : "failed"
      }`;
      getState().log(5, msg);
      return {
        notify: msg,
      };
    },
    requireRow: true,
  },
  rerun_multiple_workflows: {
    description: "Rerun multiple recorded user workflows",
    configFields: async ({ table, old_config }) => {
      if (!table)
        throw new Error("Please select a table to configure this action");
      const { nameOpts, dataOpts, wfRunRelOpts, successFlagOpts } =
        await cfgOpts(table.id);
      const allWorkflows = await table.getRows();
      let workflowNameField = old_config?.workflow_name_field;
      if (!workflowNameField) {
        const firstStringField = table.fields.find((f) => f.type === "String");
        workflowNameField = firstStringField
          ? firstStringField.name
          : table.pk_name;
      }
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
            "This is an optional relation pointing to a child table that stores re-run results (format: results_table.key_to_top_table)",
          attributes: {
            options: wfRunRelOpts,
          },
        },
        {
          name: "success_flag_field",
          label: "Success Flag Field",
          type: "String",
          sublabel: "Boolean field to indicate if a re-run run was successful",
          attributes: {
            calcOptions: ["workflow_run_relation", successFlagOpts],
          },
        },
        new FieldRepeat({
          name: "workflows_ids",
          label: "Workflows to run",
          fields: [
            {
              name: "workflow_id",
              label: "Workflow Name",
              type: "String",
              required: true,
              attributes: {
                options: allWorkflows.map((wf) => {
                  return {
                    label: wf[workflowNameField],
                    name: wf[table.pk_name || "id"],
                  };
                }),
              },
            },
          ],
        }),
      ];
    },
    run: async ({ configuration }) => {
      const { workflow_table, workflow_name_field, workflows_ids } =
        configuration;
      const wfTbl = Table.findOne({ name: workflow_table });
      // optional workflow_run_relation to store run results
      const wfRunRel = configuration.workflow_run_relation
        ? parseRelation(configuration.workflow_run_relation)
        : null;
      const workflows = await wfTbl.getRows({
        id: {
          in: workflows_ids.map((wf) => wf["workflow_id"]),
        },
      });
      const failedWorkflows = [];
      for (const row of workflows) {
        const wfName = row[workflow_name_field];
        getState().log(5, `Rerunning workflow ${wfName}`);
        const runHelper = new RerunHelper(wfTbl, row, wfRunRel, configuration);
        const wfRunId = wfRunRel
          ? await insertWfRunRow(row[wfTbl.pk_name || "id"], wfRunRel)
          : null;
        if (typeof wfRunId === "string") {
          failedWorkflows.push(wfName);
          getState().log(2, `Error inserting workflow_run row: ${wfRunId}`);
          continue;
        }

        const success = await runHelper.rerun(wfRunId);
        getState().log(
          5,
          `Rerun of workflow ${wfName} completed with status ${success}`,
        );
        if (!success) failedWorkflows.push(wfName);
      }
      if (failedWorkflows.length > 0)
        return {
          error: `Some workflows failed: ${failedWorkflows.join(", ")}`,
        };
      else
        return {
          notify: "All workflows completed successfully",
        };
    },
    requireRow: false,
    disableInBuilder: true,
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
            "This is a relation pointing to a child table that stores re-run results (format: results_table.key_to_top_table)",
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
      const msg = `Workflow benchmark completed: ${
        success ? "success" : "failed"
      }`;
      getState().log(5, msg);
      return {
        notify: msg,
      };
    },
    requireRow: true,
  },
};
