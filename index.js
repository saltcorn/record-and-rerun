const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Plugin = require("@saltcorn/data/models/plugin");
const { script, domReady, code } = require("@saltcorn/markup/tags");
const { rerun_user_workflow } = require("./actions");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");

const { spawn } = require("child_process");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Record and Rerun Settings",
        form: async (context) => {
          return new Form({
            blurb:
              "This plugin allows recording user interactions and rerunning them later. " +
              "For this you will need the Playwright framework installed on your server. " +
              `Click 'install Playwright' to run ${code(
                "npm exec install playwright",
              )}.` +
              "or skip it if your server already has Playwright installed.",
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
            fields: [],
          });
        },
      },
    ],
  });

const routes = (config) => {
  return [
    {
      // spawns 'npx playwright install' and updates the plugin configuration
      url: "/record-and-rerun/install-playwright",
      method: "post",
      callback: async (req, res) => {
        try {
          getState().log(5, "Starting Playwright installation");
          let plugin = await Plugin.findOne({ name: "record-and-rerun" });
          if (!plugin) {
            plugin = await Plugin.findOne({
              name: "@saltcorn/record-and-rerun",
            });
          }

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
            getState().log(2, `Playwright installation error: ${err.message}`);
            const errorCfg = {
              ...(plugin.configuration || {}),
              playwright_installation_finished: null,
              playwright_installation_error: err.message,
            };
            plugin.configuration = errorCfg;
            await plugin.upsert();
            getState().processSend({
              refresh_plugin_cfg: plugin.name,
              tenant: db.getTenantSchema(),
            });
          });
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

module.exports = {
  plugin_name: "record-and-rerun",
  viewtemplates: () => [require("./record-events")],
  dependencies: ["@saltcorn/json"],
  actions: () => {
    return { rerun_user_workflow };
  },
  headers: () => [
    {
      script: `/plugins/public/record-and-rerun@${
        require("./package.json").version
      }/record-and-rerun-helpers.js`,
    },
    {
      css: `/plugins/public/record-and-rerun@${
        require("./package.json").version
      }/record-and-rerun.css`,
    },
    {
      headerTag: script(
        domReady(`
  const { recording, newSession, workflowName } = RecordAndRerun.getCfg();
  if (recording && newSession) {
    RecordAndRerun.showRecordingBox(workflowName, () => {
      RecordAndRerun.recorder.stopRecording();
      const oldCfg = RecordAndRerun.getCfg();
      RecordAndRerun.setCfg({ ...oldCfg, recording: false, newSession: false });
      RecordAndRerun.hideRecordingBox();
      const indicator = document.getElementById('recording-indicator');
      if (indicator) indicator.textContent = "";
    });
  }
  `),
      ),
    },
  ],
  configuration_workflow,
  routes,
};
