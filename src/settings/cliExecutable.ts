import type * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CLI_EXECUTABLE = 'gakrcli';

type ConfigLike = Pick<vscode.WorkspaceConfiguration, 'get'>;

export interface CliLaunchCommand {
  executable: string;
  args: string[];
  displayCommand: string;
}

export function resolveCliExecutable(config: ConfigLike): string {
  return resolveCliLaunchCommand(config).executable;
}

export function resolveCliLaunchCommand(
  config: ConfigLike,
  workspaceFolder?: string,
): CliLaunchCommand {
  const wrapper = config.get<string>('processWrapper', '')?.trim();
  if (wrapper) {
    return {
      executable: wrapper,
      args: [],
      displayCommand: quoteShellToken(wrapper),
    };
  }

  const localCli = workspaceFolder
    ? resolveLocalSourceCli(workspaceFolder)
    : undefined;
  if (localCli) {
    return {
      executable: process.execPath,
      args: [localCli],
      displayCommand: [process.execPath, localCli].map(quoteShellToken).join(' '),
    };
  }

  return {
    executable: DEFAULT_CLI_EXECUTABLE,
    args: [],
    displayCommand: DEFAULT_CLI_EXECUTABLE,
  };
}

function resolveLocalSourceCli(workspaceFolder: string): string | undefined {
  const packageJsonPath = join(workspaceFolder, 'package.json');
  const cliPath = join(workspaceFolder, 'dist', 'cli.mjs');
  if (!existsSync(packageJsonPath) || !existsSync(cliPath)) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: string;
      bin?: Record<string, string>;
    };
    if (
      packageJson.name === '@gakr-gakr/gakrcli' &&
      packageJson.bin?.gakrcli === 'bin/gakrcli.js'
    ) {
      return cliPath;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function quoteShellToken(value: string): string {
  if (!value) return '""';
  if (!/[\s"'&()<>^|]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
