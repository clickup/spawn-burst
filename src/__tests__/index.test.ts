import fs from "fs";
import { tmpdir } from "os";
import { Worker } from "jest-worker";
import range from "lodash/range";
import type { SpawnBurstOptions, spawnBurstSync } from "../index";
import { spawnBurst } from "../index";

const MODES = ["sync", "async"] as const;
const worker = new Worker(require.resolve("../index"));

let seq = 0;
let CACHE_FILE: string;
let ARGS_FAST: SpawnBurstOptions;
let ARGS_SLOW: SpawnBurstOptions;
let ARGS_FAST_NONZERO_EXIT: SpawnBurstOptions;

beforeEach(async () => {
  CACHE_FILE = tmpdir() + `/spawn-burst.test.${process.pid}.${seq++}.cache`;
  ARGS_FAST = {
    cmd: 'sleep 0.05 && echo "ok $$ $(date -R)"',
    cacheFile: CACHE_FILE,
    cacheMaxAgeSec: 0,
    validator: ".+",
  };
  ARGS_SLOW = {
    cmd: 'sleep 5 && echo "ok $$ $(date -R)"',
    cacheFile: CACHE_FILE,
    cacheMaxAgeSec: 0,
    validator: ".+",
  };
  ARGS_FAST_NONZERO_EXIT = {
    cmd: "sleep 0.05; echo bad >&2; exit 1",
    cacheFile: CACHE_FILE,
    cacheMaxAgeSec: 0,
    validator: ".+",
  };
  await fs.promises.writeFile(CACHE_FILE, "");
});

afterEach(async () => {
  await fs.promises.unlink(CACHE_FILE).catch(() => {});
});

test.each(MODES)("run one successfully, %p", async (mode) => {
  const mtimeBefore = fs.statSync(CACHE_FILE).mtime.getTime();
  expect(await runSpawnBurst(mode, ARGS_FAST)).toContain("ok");
  expect(fs.statSync(CACHE_FILE).mtime.getTime()).toBeGreaterThan(mtimeBefore);
  expect(fs.statSync(CACHE_FILE).mode & 0o777).toEqual(0o600);
});

test.each(MODES)("run twice successfully, %p", async (mode) => {
  const res1 = await runSpawnBurst(mode, ARGS_FAST);
  const res2 = await runSpawnBurst(mode, ARGS_FAST);
  expect(res2).not.toEqual(res1);
});

test.each(MODES)("run twice with stale read, %p", async (mode) => {
  const res1 = await runSpawnBurst(mode, ARGS_FAST);
  const res2 = await runSpawnBurst(mode, { ...ARGS_FAST, cacheMaxAgeSec: 30 });
  expect(res2).toEqual(res1);
  expect(fs.statSync(CACHE_FILE).mode & 0o777).toEqual(0o600);
});

test.each(MODES)("run one failing validation, %p", async (mode) => {
  const mtimeBefore = fs.statSync(CACHE_FILE).mtime.getTime();
  await expect(
    runSpawnBurst(mode, {
      ...ARGS_FAST,
      validator: "^.{100,}$",
    })
  ).rejects.toThrow(/is not valid/);
  expect(fs.statSync(CACHE_FILE).mtime.getTime()).toEqual(mtimeBefore);
});

test.each(MODES)("run one returning non-zero exit code, %p", async (mode) => {
  const mtimeBefore = fs.statSync(CACHE_FILE).mtime.getTime();
  await expect(runSpawnBurst(mode, ARGS_FAST_NONZERO_EXIT)).rejects.toThrow(
    /bad/
  );
  expect(fs.statSync(CACHE_FILE).mtime.getTime()).toEqual(mtimeBefore);
});

test.each(MODES)("coalesce multiple runs into one, %p", async (mode) => {
  const mtimeBefore = fs.statSync(CACHE_FILE).mtime.getTime();
  const res = await Promise.all(
    range(5).map(async () => runSpawnBurst(mode, ARGS_SLOW))
  );
  expect(fs.statSync(CACHE_FILE).mtime.getTime()).toBeGreaterThan(mtimeBefore);
  expect(res.join(" | ")).toEqual(res.map(() => res[0]).join(" | "));
});

async function runSpawnBurst(
  mode: typeof MODES[number],
  ...args: Parameters<typeof spawnBurstSync>
): Promise<string> {
  const res =
    mode === "sync"
      ? await (worker as any).spawnBurstSync(...args)
      : await spawnBurst(...args);
  return res.trimRight();
}
