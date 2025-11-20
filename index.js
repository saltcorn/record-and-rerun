const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Plugin = require("@saltcorn/data/models/plugin");
const { script, domReady, code } = require("@saltcorn/markup/tags");
const {
  rerun_user_workflow,
  benchmark_user_workflow,
  rerun_multiple_workflows,
} = require("./actions");
const {
  getTablesIfExists,
  getExistingViews,
  createTables,
  createViews,
} = require("./common");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");

const { spawn } = require("child_process");

const configuration_workflow = () =>
  new Workflow({
    onDone: async (context) => {
      if (context.setup_schema) {
        const schema = (await getTablesIfExists()) || (await createTables());
        const views = await getExistingViews(schema);
        await createViews(schema, views);
        await getState().refresh(false);
      }
      return {
        context,
      };
    },
    steps: [
      {
        name: "Record and Rerun Settings",
        form: async (context) => {
          const fields = [];
          const schema = await getTablesIfExists();
          const existingViews = schema ? await getExistingViews(schema) : null;
          if (!schema || !existingViews.allViewsExist) {
            fields.push({
              name: "setup_schema",
              label: "Setup schema",
              sublabel:
                "Prepare a basic database schema with views for Record and Rerun. " +
                "If the tables already exist, only the views will be created.",
              type: "Bool",
              default: true,
            });
          }
          return new Form({
            blurb:
              "This plugin allows recording user interactions (session) and rerunning them later. " +
              "For this you will need the Playwright framework installed on your server. " +
              `Click 'install Playwright' to run ${code(
                "npm exec install playwright",
              )}.` +
              "or skip it if your server already has Playwright installed.",
            fields: fields,
            additionalHeaders: [
              {
                headerTag: `<script>

  let checkInterval = null;
  async function run_install_playwright() {
    const response = await fetch("/record-and-rerun/install-playwright", { 
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "CSRF-Token": _sc_globalCsrf 
      }
    });
    const result = await response.json();
    notifyAlert({
      type: "info",
      text: result.notify,
    });
    document.getElementById("install-playwright").disabled = true;
    checkInterval = setInterval(check_playwright_installation, 5000);
  }

  async function check_playwright_installation() {
    console.log("Checking Playwright installation status...");
    const response = await fetch("/record-and-rerun/check-playwright-installation", { 
      method: "GET", 
      headers: { 
        "Content-Type": "application/json",
        "CSRF-Token": _sc_globalCsrf
      } 
    });
    const result = await response.json();
    console.log("Playwright installation status:", result);
    if (result.installFinished) {
      notifyAlert({
        type: "info",
        text: "Playwright installed successfully",
      });
      document.getElementById("install-playwright").disabled = true;
      clearInterval(checkInterval);
    } else if (result.installError) {
      notifyAlert({
        type: "danger",
        text: "Playwright installation failed: " + result.installError,
      });
      document.getElementById("install-playwright").disabled = false;
      clearInterval(checkInterval);
    }
  }
  
</script>`,
              },
            ],
            additionalButtons: [
              {
                label: "install Playwright",
                id: "install-playwright",
                class: "btn btn-primary",
                onclick: "run_install_playwright()",
              },
            ],
          });
        },
      },
    ],
  });

const writeInstallError = async (plugin, errorMsg) => {
  getState().log(2, `Playwright installation error: ${errorMsg}`);
  const errorCfg = {
    ...(plugin.configuration || {}),
    playwright_installation_finished: null,
    playwright_installation_error: errorMsg,
  };
  plugin.configuration = errorCfg;
  await plugin.upsert();
  getState().processSend({
    refresh_plugin_cfg: plugin.name,
    tenant: db.getTenantSchema(),
  });
};

const playwrightInstaller = async (plugin) => {
  getState().log(5, "Starting Playwright installation");
  const child = spawn("npm", ["exec", "playwright", "install"], {
    stdio: "inherit",
    cwd: __dirname,
  });

  plugin.configuration = {
    ...(plugin.configuration || {}),
    playwright_installation_started: new Date().valueOf(),
    playwright_installation_finished: null,
    playwright_installation_error: null,
  };
  await plugin.upsert();
  getState().processSend({
    refresh_plugin_cfg: plugin.name,
    tenant: db.getTenantSchema(),
  });

  child.on("close", async (code, signal) => {
    if (code === 0) {
      getState().log(5, "Playwright installation completed");
      plugin.configuration = {
        ...(plugin.configuration || {}),
        playwright_installation_finished: new Date().valueOf(),
        playwright_installation_error: null,
      };
    } else {
      const msg = `Playwright installation failed with code ${code} and signal ${signal}`;
      getState().log(2, msg);
      plugin.configuration = {
        ...(plugin.configuration || {}),
        playwright_installation_finished: null,
        playwright_installation_error: msg,
      };
    }
    await plugin.upsert();
    getState().processSend({
      refresh_plugin_cfg: plugin.name,
      tenant: db.getTenantSchema(),
    });
  });

  child.on("error", async (err) => {
    await writeInstallError(plugin, err.message);
  });
};

const routes = (config) => {
  return [
    {
      // spawns 'npx playwright install' and updates the plugin configuration
      url: "/record-and-rerun/install-playwright",
      method: "post",
      callback: async (req, res) => {
        try {
          getState().log(5, "Playwright installation");
          let plugin = await Plugin.findOne({ name: "record-and-rerun" });
          if (!plugin) {
            plugin = await Plugin.findOne({
              name: "@saltcorn/record-and-rerun",
            });
          }
          playwrightInstaller(plugin);
          res.json({ notify: "Playwright installation started." });
        } catch (e) {
          const msg = `Error starting Playwright installation: ${e.message}`;
          getState().log(2, msg);
          res.status(500).json({ error: msg });
        }
      },
    },
    {
      // poll-service to check the installation status
      url: "/record-and-rerun/check-playwright-installation",
      method: "get",
      callback: async (req, res) => {
        try {
          getState().log(5, "Checking Playwright installation status");
          let plugin = await Plugin.findOne({ name: "record-and-rerun" });
          if (!plugin) {
            plugin = await Plugin.findOne({
              name: "@saltcorn/record-and-rerun",
            });
          }

          const installFinished =
            plugin.configuration &&
            plugin.configuration.playwright_installation_finished;
          const installError =
            plugin.configuration &&
            plugin.configuration.playwright_installation_error;
          res.json({
            installFinished,
            installError,
          });
        } catch (e) {
          const msg = `Error checking Playwright installation: ${e.message}`;
          getState().log(2, msg);
          res.status(500).json({
            error: msg,
          });
        }
      },
    },
  ];
};

const onlyIfCallback = () => {
  const state = getState();
  if (!state.plugin_cfgs || !state.plugin_cfgs["record-and-rerun"]) return true;
  else {
    return (
      state.plugin_cfgs["record-and-rerun"].active_recording_ids?.length > 0
    );
  }
};

module.exports = {
  plugin_name: "record-and-rerun",
  viewtemplates: () => [require("./record-events")],
  dependencies: ["@saltcorn/json"],
  actions: () => {
    return {
      rerun_user_workflow,
      benchmark_user_workflow,
      rerun_multiple_workflows,
    };
  },
  headers: () => [
    {
      script: `/plugins/public/record-and-rerun@${
        require("./package.json").version
      }/record-and-rerun-helpers.js`,
    },
    {
      only_if: onlyIfCallback,
      css: `/plugins/public/record-and-rerun@${
        require("./package.json").version
      }/record-and-rerun.css`,
    },
    {
      only_if: onlyIfCallback,
      headerTag: script(
        domReady(`
  const { recording, workflowName } = RecordAndRerun.getCfg();
  if (recording) {
    const asyncFn = async () => {
      await RecordAndRerun.recorder.startRecording();
      RecordAndRerun.showRecordingBox(workflowName, async () => {
        try {
          if (window._sc_loglevel > 4) console.log("Stop recording calback");
          await RecordAndRerun.recorder.stopRecording();
          const oldCfg = RecordAndRerun.getCfg();
          RecordAndRerun.setCfg({ ...oldCfg, recording: false});
          RecordAndRerun.removeRecordingBox();
          const indicator = document.getElementById('recording-indicator');
          if (indicator) indicator.textContent = "";
        } catch (err) {
          console.error("Error stopping recording:", err);
          notifyAlert({
            type: "danger",
            text: err.message || "Error stopping recording",
          });
          const oldCfg = RecordAndRerun.getCfg();
          RecordAndRerun.setCfg({ ...oldCfg, recording: false});
          RecordAndRerun.removeRecordingBox();
        }
      });
    };
    asyncFn().catch((err) => {
      console.error("Error starting recording:", err);
      notifyAlert({
        type: "danger",
        text: err.message || "Error starting recording",
      });
      const oldCfg = RecordAndRerun.getCfg();
      RecordAndRerun.setCfg({ ...oldCfg, recording: false});
      RecordAndRerun.removeRecordingBox();
      const indicator = document.getElementById('recording-indicator');
      if (indicator) indicator.textContent = "";
    });
  }`),
      ),
    },
  ],
  configuration_workflow,
  routes,
  ready_for_mobile: true,
};
