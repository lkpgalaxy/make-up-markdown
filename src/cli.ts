#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { initProject, renderProject, startAnnotationServer, syncAnnotations, type CommandResult } from "./index.js";

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

program
  .command("annotate [files...]")
  .description("Start a local browser annotation server for Markdown files.")
  .option("--port <number>", "Local server port. Use 0 to choose an available port.", parsePort, 0)
  .option("--host <host>", "Local server host.", "127.0.0.1")
  .option("--no-open", "Do not open the annotation URL in the default browser.")
  .action(async (files: string[], options: { port: number; host: string; open: boolean }) => {
    try {
      const server = await startAnnotationServer({ inputs: files, port: options.port, host: options.host });
      console.log(`annotation server ${server.url}`);
      if (options.open) {
        openBrowser(server.url);
      }
      process.once("SIGINT", () => {
        server.close().finally(() => {
          process.exitCode = 0;
          process.exit();
        });
      });
      process.once("SIGTERM", () => {
        server.close().finally(() => {
          process.exitCode = 0;
          process.exit();
        });
      });
    } catch (error) {
      reportError(error);
      process.exitCode = 1;
    }
  });

program
  .command("sync [annotationsFile]")
  .description("Sync managed annotation callouts from an annotation JSON file into Markdown.")
  .option("--dry-run", "Print planned Markdown updates without writing files.")
  .action(async (annotationsFile: string | undefined, options: { dryRun?: boolean }) => {
    await runCommand(() => syncAnnotations({ annotationsFile, dryRun: options.dryRun }));
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

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${value}".`);
  }

  return port;
}

function openBrowser(url: string): void {
  const command = browserOpenCommand(url);

  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      console.warn(`warning could not open annotation server in browser: ${error.message}`);
    });
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`warning could not open annotation server in browser: ${message}`);
  }
}

function browserOpenCommand(url: string): { file: string; args: string[] } {
  if (process.platform === "darwin") {
    return { file: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { file: process.env.ComSpec ?? "cmd", args: ["/c", "start", "", url] };
  }

  return { file: "xdg-open", args: [url] };
}
