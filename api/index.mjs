import { handleRequest, prepareServer } from "../web/server.mjs";

const ready = prepareServer();

export default async function handler(request, response) {
  await ready;
  await handleRequest(request, response);
}
