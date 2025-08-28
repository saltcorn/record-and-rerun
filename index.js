module.exports = {
  plugin_name: "record-and-replay",
  viewtemplates: [require("./record-events")],
  dependencies: ["@saltcorn/json"],
  headers: [
    {
      script: `/plugins/public/record-and-replay@${
        require("./package.json").version
      }/record-and-rerun-helpers.js`,
    },
  ],
};
