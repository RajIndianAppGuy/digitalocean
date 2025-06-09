import { getExtensionSelector } from "../utils/helper.js";

export default async function extension(req, res) {
  const element = req.body.element;

  const output = await getExtensionSelector(element);
  console.log(output);
  res.send(output);
}
