const { cfgOpts, parseDataField, createTestDirName } = require("./common");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs").promises;

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
          name: "html_report_file_directory",
          label: "HTML Report File Directory",
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
      const {
        workflow_name_field,
        data_field,
        html_report_file,
        html_report_file_directory,
      } = configuration;
      const { dataTblName, dataField, topFk } = parseDataField(data_field);
      const eventsTable = Table.findOne({ name: dataTblName });
      if (!eventsTable) throw new Error(`Table ${dataTblName} not found`);

      const safeWorkflowName = row[workflow_name_field].replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );
      const dedicatedTestDir = createTestDirName(safeWorkflowName);
      await fs.cp(
        path.join(__dirname, "playwright_template"),
        dedicatedTestDir,
        {
          recursive: true,
        },
      );

      // put the events into a json file
      await fs.writeFile(
        path.join(dedicatedTestDir, "events.json"),
        JSON.stringify(
          {
            events: (await eventsTable.getRows({ [topFk]: row.id })).map(
              (r) => r[dataField],
            ),
            workflow_name: row[workflow_name_field],
          },
          null,
          2,
        ),
      );

      // run the playwright script
      const child = spawn(path.join(dedicatedTestDir, "run.sh"), {
        cwd: dedicatedTestDir,
        stdio: "inherit",
      });
      await new Promise((resolve, reject) => {
        child.on("exit", async (code) => {
          if (code === 0) {
            if (html_report_file) {
              const reportFile = await File.from_file_on_disk(
                "index.html",
                path.join(dedicatedTestDir, "my-report"),
              );
              const newPath = File.get_new_path(
                path.join(
                  html_report_file_directory || "/",
                  `${safeWorkflowName}.html`,
                ),
                true,
              );
              const newName = path.basename(newPath);
              await reportFile.rename(newName);
              await reportFile.move_to_dir(html_report_file_directory || "/");
            }
            resolve();
          } else reject(new Error(`Playwright tests failed with code ${code}`));
        });
      });

      return {
        success: true,
        notify_success: "The workflow completed successfully",
      };
    },
    requireRow: true,
  },
};
