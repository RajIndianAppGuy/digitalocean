import { updateTest } from "../supabase/tables.js";

export default async function updateTestData(req, res) {
  const { id, updatedData } = req.body;
  const output = await updateTest(id, updatedData);
  console.log(output);
  res.send(output);
}
