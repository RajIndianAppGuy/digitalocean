import { storeTest } from "../supabase/tables.js";

export default async function createTest(req, res) {
  const { name, url, email } = req.body;
  const output = await storeTest(name, url, email);
  console.log(output);
  res.send(output);
}
