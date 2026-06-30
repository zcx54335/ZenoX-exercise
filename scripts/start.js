import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

loadEnvFile();

const port = Number(process.env.PORT || 8080);
const watch = process.argv.includes("--watch");

stopPort(port);

const args = watch ? ["--watch", "server/index.js"] : ["server/index.js"];
const child = spawn(process.execPath, args, {
  cwd: rootDir,
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

function loadEnvFile() {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = rest.join("=").replace(/^['"]|['"]$/g, "");
  }
}

function stopPort(targetPort) {
  if (!targetPort) return;
  const pids = process.platform === "win32"
    ? windowsPortPids(targetPort)
    : unixPortPids(targetPort);

  const safePids = pids
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .filter((pid) => pid !== process.pid && pid !== process.ppid);

  if (!safePids.length) return;
  console.log(`Port ${targetPort} is in use. Stopping old process: ${safePids.join(", ")}`);
  for (const pid of safePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may already have exited or belong to another user.
      }
    }
  }
}

function unixPortPids(targetPort) {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${targetPort}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return parsePidList(output);
  } catch {
    return [];
  }
}

function windowsPortPids(targetPort) {
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return parsePidList(output);
  } catch {
    try {
      const output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      return output
        .split(/\r?\n/)
        .filter((line) => line.includes(`:${targetPort}`) && /\bLISTENING\b/i.test(line))
        .map((line) => Number(line.trim().split(/\s+/).at(-1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }
}

function parsePidList(output = "") {
  return output
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
