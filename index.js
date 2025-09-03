const { rerun_user_workflow } = require("./actions");

module.exports = {
  plugin_name: "record-and-rerun",
  viewtemplates: [require("./record-events")],
  dependencies: ["@saltcorn/json"],
  actions: { rerun_user_workflow },
  headers: [
    {
      script: `/plugins/public/record-and-rerun@${
        require("./package.json").version
      }/record-and-rerun-helpers.js`,
    },
  ],
};
