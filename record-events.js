const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
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
const { getState } = require("@saltcorn/data/db/state");
const { cfgOpts, parseDataField, createTestDirName } = require("./common");

const fs = require("fs").promises;

const get_state_fields = async () => [];

const run = async (
  table_id,
  viewname,
  { workflow_name_field },
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
          onclick: "initRecording()",
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
        const newSessionMsg = "⚠️ Workflow initialized — log out and start a new session to begin recording.";
        const recordingMsg = "🔴 Recording...";
        const currentCfg = RecordAndRerun.getCfg();
        if (currentCfg.viewname === '${viewname}' && currentCfg.recording) {
          document.getElementById('workflow_name').value = currentCfg.workflow['${workflow_name_field}'] || '';
          indicator.textContent = currentCfg.newSession ? recordingMsg : newSessionMsg;
          indicator.style.color = currentCfg.newSession ? "red" : "orange";
        }
        else {
          const now = new Date();
          const defaultName = 'Workflow_' + now.toISOString().slice(0,19).replace('T',' ');
          document.getElementById('workflow_name').value = defaultName;
        }

        window.initRecording = async () => {
          const newWorkflow = await RecordAndRerun.initWorkflow(
            '${viewname}', 
            document.getElementById('workflow_name').value
          );
          if (newWorkflow) {
            RecordAndRerun.setCfg({
              viewname: '${viewname}',
              recording: true,
              newSession: false,
              workflow: newWorkflow,
              workflowName: document.getElementById('workflow_name').value
            });
            indicator.textContent = newSessionMsg;
            indicator.style.color = "orange";
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
    getState().log(5, `Uploading ${body.length} events`);
    const { dataTblName, dataField, topFk } = parseDataField(data_field);
    const dataTbl = Table.findOne({ name: dataTblName });
    if (!dataTbl) throw new Error(`Table ${dataTblName} not found`);
    for (const event of body.events || []) {
      await dataTbl.insertRow({
        [dataField]: event,
        [topFk]: body.workflow_id,
      });
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
  { workflow_name_field },
  body,
  { req },
) => {
  try {
    getState().log(5, `Initializing workflow ${body.workflow_name}`);
    const table = await Table.findOne({ id: table_id });
    if (!table) throw new Error(`Table with id ${table_id} not found`);
    const id = await table.insertRow({
      [workflow_name_field]: body.workflow_name,
    });
    const newRow = await table.getRow({ [table.pk_name]: id });
    return { json: { success: "ok", created: newRow } };
  } catch (e) {
    getState().log(2, `Error initializing workflow: ${e.message}`);
    return { json: { error: e.message || "unknown error" } };
  }
};

const virtual_triggers = (
  table_id,
  viewname,
  { data_field, workflow_name_field },
) => {
  const table = Table.findOne({ id: table_id });
  return [
    {
      when_trigger: "Delete",
      table_id: table_id,
      run: async (row) => {
        getState().log(5, `Deleting events for workflow id ${row[table.pk_name]}`);
        const { dataTblName, topFk } = parseDataField(data_field);
        const dataTbl = Table.findOne({ name: dataTblName });
        if (!dataTbl) throw new Error(`Table ${dataTblName} not found`);

        await dataTbl.deleteRows({ [topFk]: row[table.pk_name] });
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

	// TODO
        // find re-run and benchmark actions for this table and 
        // delete rows in workflow_run_relation for row[table.pk_name]
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
