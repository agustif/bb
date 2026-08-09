import semver from "semver";
import { z } from "zod";
import type { SystemVersionResponse } from "@bb/server-contract";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";

const NPM_LATEST_URL = "https://registry.npmjs.org/bb-app/latest";
const NPM_LATEST_TIMEOUT_MS = 5_000;
const NPM_LATEST_CACHE_TTL_MS = 60 * 60 * 1000;
const UPGRADE_COMMAND = "npx bb-app@latest";
const FORK_UPGRADE_COMMAND = "bb-update-fork --pull";

const npmLatestResponseSchema = z
  .object({
    version: z.string().min(1),
  })
  .passthrough();

/**
 * True when this install is a local/fork build stamped as a prerelease of the
 * public X.Y.Z line (e.g. `0.36.0-agustif.5663b9b`). Semver treats that as
 * older than npm `0.36.0`, which would wrongly advertise an "upgrade" that
 * replaces the fork with upstream.
 */
export function isForkStampedVersion(version: string): boolean {
  const parsed = semver.parse(version);
  if (parsed === null || parsed.prerelease.length === 0) {
    return false;
  }
  return parsed.prerelease.some(
    (part) => typeof part === "string" && part.toLowerCase() === "agustif",
  );
}

/**
 * Whether npm `latest` should be offered as an upgrade over the running build.
 *
 * Custom prereleases of the same X.Y.Z as a stable npm release are not upgrades
 * — installing that release would wipe fork patches. A newer X.Y.Z still is.
 */
export function isNpmUpdateAvailable(
  currentVersion: string,
  latestVersion: string,
): boolean {
  const parsedCurrent = semver.parse(currentVersion);
  const parsedLatest = semver.parse(latestVersion);
  if (parsedCurrent === null || parsedLatest === null) {
    return false;
  }

  if (
    parsedCurrent.prerelease.length > 0 &&
    parsedLatest.prerelease.length === 0 &&
    parsedCurrent.major === parsedLatest.major &&
    parsedCurrent.minor === parsedLatest.minor &&
    parsedCurrent.patch === parsedLatest.patch
  ) {
    return false;
  }

  return semver.gt(parsedLatest, parsedCurrent);
}

export interface AppVersionService {
  getSystemVersion(
    args?: AppVersionGetSystemVersionArgs,
  ): Promise<SystemVersionResponse>;
}

export interface AppVersionGetSystemVersionArgs {
  forceRefresh?: boolean;
}

export interface CreateAppVersionServiceArgs {
  config: Pick<ServerRuntimeConfig, "appVersion" | "isDevelopment">;
  fetchImpl?: typeof fetch;
  logger: ServerLogger;
  /** Override the cache TTL. Tests use this; production uses the default. */
  cacheTtlMs?: number;
  /** Inject a custom clock for cache invalidation tests. */
  now?: () => number;
}

interface NpmLatestCacheEntry {
  cachedAt: number;
  latestVersion: string;
}

export function createAppVersionService(
  args: CreateAppVersionServiceArgs,
): AppVersionService {
  const fetchImpl = args.fetchImpl ?? fetch;
  const cacheTtlMs = args.cacheTtlMs ?? NPM_LATEST_CACHE_TTL_MS;
  const now = args.now ?? (() => Date.now());
  const logger = args.logger;
  const config = args.config;

  let cache: NpmLatestCacheEntry | null = null;
  let inflight: Promise<string | null> | null = null;

  async function fetchNpmLatest(): Promise<string | null> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      NPM_LATEST_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(NPM_LATEST_URL, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status, url: NPM_LATEST_URL },
          "Failed to fetch latest bb-app version from npm",
        );
        return null;
      }
      const json = await response.json();
      const parsed = npmLatestResponseSchema.safeParse(json);
      if (!parsed.success) {
        logger.warn(
          { url: NPM_LATEST_URL, issue: parsed.error.message },
          "npm latest response did not match expected shape",
        );
        return null;
      }
      return parsed.data.version;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { url: NPM_LATEST_URL, error: message },
        "npm latest lookup failed",
      );
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  // Per Sawyer's iteration decision (2026-05-20, plan §"Iteration
  // decisions"): once the TTL has expired we always re-fetch, and a failed
  // fetch returns null even if a stale cached value exists. This is choice
  // "A" (null on failure) and overrides the plan body's earlier suggestion
  // to fall back to the stale cached value with a warning.
  async function getLatestVersion(args?: {
    forceRefresh?: boolean;
  }): Promise<string | null> {
    const currentTime = now();
    if (
      args?.forceRefresh !== true &&
      cache !== null &&
      currentTime - cache.cachedAt < cacheTtlMs
    ) {
      return cache.latestVersion;
    }
    if (inflight !== null) {
      return inflight;
    }
    const requestPromise = (async () => {
      const result = await fetchNpmLatest();
      if (result !== null) {
        cache = { cachedAt: now(), latestVersion: result };
      }
      return result;
    })();
    inflight = requestPromise;
    try {
      return await requestPromise;
    } finally {
      if (inflight === requestPromise) {
        inflight = null;
      }
    }
  }

  return {
    async getSystemVersion(
      args: AppVersionGetSystemVersionArgs = {},
    ): Promise<SystemVersionResponse> {
      const upgradeCommand = isForkStampedVersion(config.appVersion)
        ? FORK_UPGRADE_COMMAND
        : UPGRADE_COMMAND;
      const baseResponse: SystemVersionResponse = {
        currentVersion: config.appVersion,
        latestVersion: null,
        source: "npm",
        updateAvailable: false,
        isDevelopment: config.isDevelopment,
        upgradeCommand,
      };

      if (config.isDevelopment) {
        return baseResponse;
      }

      const latestVersion = await getLatestVersion({
        forceRefresh: args.forceRefresh,
      });
      if (latestVersion === null) {
        return baseResponse;
      }

      const parsedCurrent = semver.parse(config.appVersion);
      const parsedLatest = semver.parse(latestVersion);
      if (parsedCurrent === null || parsedLatest === null) {
        logger.warn(
          {
            currentVersion: config.appVersion,
            latestVersion,
          },
          "Skipping update check because a version is not valid semver",
        );
        return { ...baseResponse, latestVersion };
      }

      const updateAvailable = isNpmUpdateAvailable(
        config.appVersion,
        latestVersion,
      );

      // Fork prereleases of the same X.Y.Z as npm latest are not upgrades.
      // Report latest as current so Settings/CLI do not paint a fake A→B arrow.
      const sameCoreAsLatest =
        parsedCurrent.major === parsedLatest.major &&
        parsedCurrent.minor === parsedLatest.minor &&
        parsedCurrent.patch === parsedLatest.patch;
      const displayLatestVersion =
        !updateAvailable &&
        isForkStampedVersion(config.appVersion) &&
        sameCoreAsLatest
          ? config.appVersion
          : latestVersion;

      return {
        ...baseResponse,
        latestVersion: displayLatestVersion,
        updateAvailable,
      };
    },
  };
}
