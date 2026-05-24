#!/usr/bin/env node
import { Command } from "commander";
import { initProject, renderProject, type CommandResult } from "./index.js";

const program = new Command();

program
  .name("mum")
  .description("Render local Markdown documentation into self-contained HTML presentations.")
  .version("0.1.0");

program
  .command("init")
  .description("Prepare the current project for rendered Markdown output.")
  .action(async () => {
    await runCommand(() => initProject());
  });

program
  .command("render [files...]")
  .description("Render Markdown files into .make-up-markdown/ HTML output.")
  .action(async (files: string[]) => {
    await runCommand(() => renderProject({ inputs: files }));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  reportError(error);
  process.exitCode = 1;
});

async function runCommand(action: () => Promise<CommandResult>): Promise<void> {
  try {
    printResult(await action());
  } catch (error) {
    reportError(error);
    process.exitCode = 1;
  }
}

function printResult(result: CommandResult): void {
  for (const file of result.created) {
    console.log(`created ${file}`);
  }
  for (const file of result.reused) {
    console.log(`reused ${file}`);
  }
  for (const file of result.updated) {
    console.log(`updated ${file}`);
  }
  for (const file of result.generated) {
    console.log(`generated ${file}`);
  }
  for (const warning of result.warnings) {
    console.warn(`warning ${warning}`);
  }
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error ${message}`);
}
