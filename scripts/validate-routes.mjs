#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  activeRoutes,
  formatFailure,
  formatSkippedGuideChecks,
  validateRoutes,
} from "../src/routes-validation.mjs";

function describeReadError(error, routesFile) {
  if (error.code === "ENOENT") {
    return `routes file not found: ${routesFile}\nRun instagram-cta init first, or pass --dir with the folder that holds routes.json.`;
  }
  if (error instanceof SyntaxError) return `routes file is not valid JSON: ${routesFile}\n${error.message}`;
  return `routes file could not be read: ${routesFile}\n${error.message}`;
}

// Returns an exit code instead of calling process.exit, so a long problem list
// is never truncated on its way to a pipe.
async function main() {
  const routesFile = resolve(process.cwd(), process.env.ROUTES_FILE || "./routes.json");

  let parsed;
  try {
    parsed = JSON.parse(await readFile(routesFile, "utf8"));
  } catch (error) {
    console.error(describeReadError(error, routesFile));
    return 1;
  }

  const routes = activeRoutes(parsed);
  const { errors, warnings, exampleRoutes, skippedGuideChecks } = await validateRoutes(routes, {
    checkGuides: process.env.CHECK_GUIDES === "1",
  });

  if (errors.length) {
    console.error(formatFailure({ errors, exampleRoutes, routesFile }));
    return 1;
  }

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  const skipped = formatSkippedGuideChecks(skippedGuideChecks);
  if (skipped) console.log(skipped);
  console.log(`routes ok: ${routes.length}`);
  return 0;
}

process.exitCode = await main();
