const { cfgOpts, parseDataField } = require("./common");
const Table = require("@saltcorn/data/models/table");

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs").promises;

module.exports = {
  rerun_user_workflow: {
    description: "Rerun a recorded user workflow",
    configFields: async ({ table }) => {
      const { nameOpts, dataOpts } = await cfgOpts(table.id);
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
      ];
    },
    run: async ({ table, row, configuration }) => {
      const { workflow_name_field, data_field } = configuration;
      const { dataTblName, dataField, topFk } = parseDataField(data_field);
      const eventsTable = Table.findOne({ name: dataTblName });
      if (!eventsTable) throw new Error(`Table ${dataTblName} not found`);

      const playwrightDir = path.join(__dirname, "playwright");
      const events = (await eventsTable.getRows({ [topFk]: row.id })).map(
        (r) => r[dataField],
      );

      // put the events into a json file
      await fs.writeFile(
        path.join(playwrightDir, "events.json"),
        JSON.stringify(
          {
            events,
            workflow_name: row[workflow_name_field],
          },
          null,
          2,
        ),
      );

      // if playwrightDir has no node_modules, run npm install
      if (!(await fs.stat(path.join(playwrightDir, "node_modules")).catch(() => false))) {
        console.log("Installing Playwright dependencies...");
        const child = spawn("npm", ["install"], {
          cwd: playwrightDir,
          stdio: "inherit",
        });
        await new Promise((resolve, reject) => {
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`npm install failed with code ${code}`));
          });
        });
      }

      // npx playwright install takes longer so I avoid it for now

      // run the playwright script
      const child = spawn(path.join(playwrightDir, "run.sh"), {
        cwd: playwrightDir,
        stdio: "inherit",
      });
      await new Promise((resolve, reject) => {
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Playwright tests failed with code ${code}`));
        });
      });

      return { success: true };
    },
    requireRow: true,
  },
};
