const Table = require("@saltcorn/data/models/table");
const Field = require("@saltcorn/data/models/field");
const db = require("@saltcorn/data/db");

const path = require("path");

const cfgOpts = async (tableId) => {
  const table = await Table.findOne({ id: tableId });
  const fields = table.fields;
  const nameOpts = fields.filter((f) => f.type?.name === "String");
  const refs = await Field.find({
    reftable_name: table.name,
  });
  const dataOpts = [];
  for (const ref of refs) {
    const refTable = Table.findOne({ id: ref.table_id });
    const jsonFields = refTable.fields.filter((f) => f.type?.name === "JSON");
    dataOpts.push(
      jsonFields.map((f) => `${refTable.name}.${f.name}->${ref.name}`),
    );
  }

  return { nameOpts, dataOpts };
};

const parseDataField = (field) => {
  const match = field.match(/^([^.]+)\.([^-]+)->(.+)$/);
  if (!match) {
    throw new Error(
      "data_field must be of the form ref_table.json_field->ref_field",
    );
  }
  const [, dataTblName, dataField, topFk] = match;
  return { dataTblName, dataField, topFk };
};

const createTestDirName = (workflowName) =>
  path.join(
    __dirname,
    "playwright",
    db.getTenantSchema(),
    workflowName.replace(/[^a-zA-Z0-9_-]/g, "_"),
  );

module.exports = {
  cfgOpts,
  parseDataField,
  createTestDirName,
};
