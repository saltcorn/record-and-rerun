const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Plugin = require("@saltcorn/data/models/plugin");
const { domReady, code } = require("@saltcorn/markup/tags");
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
              `The install Playwright button runs ${code(
                "npx install playwright"
              )}.` +
              "You can skip this if your Server already has Playwright installed.",
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
          let plugin = await Plugin.findOne({ name: "record-and-rerun" });
          if (!plugin) {
            plugin = await Plugin.findOne({
              name: "@saltcorn/record-and-rerun",
            });
          }

          const child = spawn("npx", ["playwright", "install"], {
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

          child.on("exit", async (code, signal) => {
            if (code === 0) {
              plugin.configuration = {
                ...(plugin.configuration || {}),
                playwright_installation_finished: new Date().valueOf(),
                playwright_installation_error: null,
              };
            } else {
              plugin.configuration = {
                ...(plugin.configuration || {}),
                playwright_installation_finished: null,
                playwright_installation_error: `Exited with code ${code} and signal ${signal}`,
              };
            }
            await plugin.upsert();
            getState().processSend({
              refresh_plugin_cfg: plugin.name,
              tenant: db.getTenantSchema(),
            });
          });

          child.on("error", async (err) => {
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
          console.log("Error starting Playwright installation:", e);
          res
            .status(500)
            .json({ notify: `Error starting Playwright installation: ${e}` });
        }
      },
    },
    {
      // poll-service to check the installation status
      url: "/record-and-rerun/check-playwright-installation",
      method: "get",
      callback: async (req, res) => {
        try {
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
          console.log("Error checking Playwright installation:", e);
          res
            .status(500)
            .json({
              installError: `Error checking Playwright installation: ${e}`,
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
  ],
  configuration_workflow,
  routes,
};
