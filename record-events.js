const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const User = require("@saltcorn/data/models/user");
const Field = require("@saltcorn/data/models/field");
const Plugin = require("@saltcorn/data/models/plugin");
const {
  div,
  button,
  script,
  domReady,
  span,
  label,
  input,
  h5,
} = require("@saltcorn/markup/tags");
const { getState, features } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const {
  cfgOpts,
  parseDataField,
  createTestDirName,
  removeRecordingId,
} = require("./common");

const fs = require("fs").promises;

const get_state_fields = async () => [];

const run = async (
  table_id,
  viewname,
  { workflow_name_field, confirm_start_recording },
  state,
  extra,
) => {
  return div(
    { class: "card mt-4" },
    span(
      { class: "card-header" },
      div(
        { class: "card-title" },
        h5({ class: "m-0 fw-bold text-primary d-inline" }, "Record and Rerun"),
      ),
    ),
    div(
      { class: "card-body" },
      div(
        { class: "mb-3" },
        label({ for: "workflow_name", class: "form-label" }, "Workflow Name"),
        input({
          type: "text",
          class: "form-control",
          id: "workflow_name",
        }),
      ),
      button(
        {
          class: "btn btn-primary",
          onclick: confirm_start_recording
            ? "if (confirm('Start recording? You will be logged out and redirected to home.')) { initRecording(); }"
            : "initRecording()",
        },
        "Start Recording",
      ),
      button(
        {
          class: "btn btn-secondary ms-2",
          onclick: "stopRecording()",
        },
        "Stop Recording",
      ),
      span(
        { id: "recording-indicator", class: "ms-2 fw-bold text-danger" },
        "",
      ),
    ),
    script(
      domReady(`
        const indicator = document.getElementById('recording-indicator');
        const recordingMsg = "🔴 Recording...";
        const currentCfg = RecordAndRerun.getCfg();
        if (currentCfg.viewname === '${viewname}' && currentCfg.recording) {
          document.getElementById('workflow_name').value = currentCfg.workflow['${workflow_name_field}'] || '';
          indicator.textContent = currentCfg.recording ? recordingMsg : "";
          indicator.style.color = currentCfg.recording ? "red" : "";
        }
        else {
          const now = new Date();
          const defaultName = 'Workflow_' + now.toISOString().slice(0,19).replace('T',' ');
          document.getElementById('workflow_name').value = defaultName;
        }

        window.initRecording = async () => {
          const { workflow, api_token } = await RecordAndRerun.initWorkflow(
            '${viewname}', 
            document.getElementById('workflow_name').value
          );
          if (workflow) {
            const newCfg = {
              viewname: '${viewname}',
              recording: true,
              workflow: workflow,
              workflowName: document.getElementById('workflow_name').value,
              ${features.api_view_route ? "api_token: api_token," : ""}
            };
            RecordAndRerun.setCfg(newCfg);
            if (!await RecordAndRerun.startFromPublic()) {
              newCfg.recording = false;
              RecordAndRerun.setCfg(newCfg);
            }
          }
          else {
            indicator.textContent = "Error initializing workflow";
          }
        };

        window.stopRecording = () => {
          RecordAndRerun.recorder.stopRecording();
          const oldCfg = RecordAndRerun.getCfg();
          RecordAndRerun.setCfg({ ...oldCfg, recording: false });
          indicator.textContent = "";
        };
      `),
    ),
  );
};

const configuration_workflow = (cfg) =>
  new Workflow({
    steps: [
      {
        name: "storage",
        disablePreview: true,
        form: async (context) => {
          const { nameOpts, dataOpts } = await cfgOpts(context.table_id);
          return new Form({
            fields: [
              {
                name: "workflow_name_field",
                label: "Session Name",
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
                name: "workflow_type_field",
                label: "Session Type Field",
                sublabel:
                  "Optional Field to store if you're recording a web or mobile session. The default is 'Web' " +
                  "and you can leave this empty if you have no mobile sessions.",
                default: "Web",
                type: "String",
                attributes: {
                  options: nameOpts.map((f) => f.name),
                },
              },
              {
                name: "confirm_start_recording",
                label: "Confirm before starting recording",
                sublabel:
                  "Recording will log you out and redirect you to home. Check this to get a confirmation prompt.",
                type: "Bool",
                default: true,
              },
            ],
          });
        },
      },
    ],
  });

const upload_events = async (
  table_id,
  viewname,
  { data_field },
  body,
  { req },
) => {
  try {
    getState().log(5, `Uploading ${body.events?.length} events`);
    const { dataTblName, dataField, topFk } = parseDataField(data_field);
    const dataTbl = Table.findOne({ name: dataTblName });
    if (!dataTbl) throw new Error(`Table '${dataTblName}' not found`);
    const hasStopped = !!body.has_stopped;
    if (hasStopped) {
      getState().log(
        5,
        `Recording has stopped for workflow id ${body.workflow_id}`,
      );
      let plugin = await Plugin.findOne({ name: "record-and-rerun" });
      if (!plugin) {
        plugin = await Plugin.findOne({
          name: "@saltcorn/record-and-rerun",
        });
      }
      if (plugin?.configuration?.active_recording_ids) {
        plugin.configuration.active_recording_ids =
          plugin.configuration.active_recording_ids.filter(
            (id) => id !== body.workflow_id,
          );
        await plugin.upsert();
        getState().processSend({
          refresh_plugin_cfg: plugin.name,
          tenant: db.getTenantSchema(),
        });
      }
    }
    for (const event of body.events || []) {
      await dataTbl.insertRow(
        {
          [dataField]: event,
          [topFk]: body.workflow_id,
        },
        req.user,
      );
    }
    return { json: { success: "ok" } };
  } catch (e) {
    getState().log(2, `Error uploading events: ${e.message}`);
    return { json: { error: e.message || "unknown error" } };
  }
};

const init_workflow = async (
  table_id,
  viewname,
  { workflow_name_field, workflow_type_field },
  body,
  { req },
) => {
  try {
    getState().log(5, `Initializing workflow ${body.workflow_name}`);
    const table = Table.findOne(table_id);
    if (!table) throw new Error(`Table with id '${table_id}' not found`);
    const row = {
      [workflow_name_field]: body.workflow_name,
    };
    if (workflow_type_field) {
      row[workflow_type_field] = body.workflow_type || "Web";
    }
    const id = await table.insertRow(row, req.user);
    const result = {
      json: {
        success: "ok",
        created: await table.getRow({ [table.pk_name]: id }),
      },
    };
    if (features.api_view_route) {
      const userDb = await User.findOne({ id: req.user.id });
      if (userDb?.api_token) result.json.api_token = userDb.api_token;
      else if (userDb?.listApiTokens) {
        const tokens = await userDb.listApiTokens();
        if (tokens.length > 0) result.json.api_token = tokens[0].token;
      }
    }
    let plugin = await Plugin.findOne({ name: "record-and-rerun" });
    if (!plugin) {
      plugin = await Plugin.findOne({
        name: "@saltcorn/record-and-rerun",
      });
    }
    if (!plugin.configuration)
      plugin.configuration = { active_recording_ids: [id] };
    else if (!plugin.configuration.active_recording_ids)
      plugin.configuration.active_recording_ids = [id];
    else plugin.configuration.active_recording_ids.push(id);
    await plugin.upsert();
    getState().processSend({
      refresh_plugin_cfg: plugin.name,
      tenant: db.getTenantSchema(),
    });
    return result;
  } catch (e) {
    getState().log(2, `Error initializing workflow: ${e.message}`);
    return { json: { error: e.message || "unknown error" } };
  }
};

const virtual_triggers = (table_id, viewname, { workflow_name_field }) => {
  const table = Table.findOne({ id: table_id });
  return [
    {
      when_trigger: "Delete",
      table_id: table_id,
      run: async (row) => {
        const wfId = row[table.pk_name];
        getState().log(
          5,
          `Deleting rows with a ref to workflow with id '${wfId}'`,
        );
        const refFields = await Field.find({ reftable_name: table.name });
        for (const rf of refFields) {
          const refTable = Table.findOne(rf.table_id);
          if (refTable) {
            await refTable.deleteRows({ [rf.name]: wfId });
          }
        }

        getState().log(
          5,
          `Deleting test directory for workflow '${row[workflow_name_field]}'`,
        );
        const safeWorkflowName = row[workflow_name_field].replace(
          /[^a-zA-Z0-9_-]/g,
          "_",
        );
        const dedicatedTestDir = createTestDirName(safeWorkflowName);
        try {
          await fs.rm(dedicatedTestDir, { recursive: true, force: true });
        } catch (e) {
          getState().log(2, `Error deleting test directory: ${e.message}`);
        }

        await removeRecordingId(wfId, true);
      },
    },
  ];
};

module.exports = {
  name: "RecordEvents",
  description: "Record user interactions (workflows)",
  configuration_workflow,
  run,
  routes: { upload_events, init_workflow },
  get_state_fields,
  virtual_triggers,
};
