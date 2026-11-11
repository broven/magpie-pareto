// The page's service. It listens on the option port (3498 by default) and
// waits while another program holds it, as internal/plugin/testdata/pageservice
// does. The global guard keeps a second load from starting it again.
import { startService } from "./src/server.ts";

const running = Symbol.for("magpie-pareto.service");

export const Pareto = async (_input, options = {}) => {
  const fromOption = Number(options?.port);
  const fromEnv = Number(process.env.PARETO_PORT);
  const port = Number.isInteger(fromOption) && fromOption > 0
    ? fromOption
    : Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 3498;
  const old = globalThis[running];
  if (old && old.port === port) return {};
  // Not awaited: while the host restarts, the old one holds the port for a
  // while, and magpie gives a plugin's load 20s. The service retries in the
  // background and the load returns at once.
  globalThis[running] = { port };
  startService({
    port,
    magpieBin: typeof options?.magpieBin === "string" ? options.magpieBin : undefined,
    retry: true,
    log: false,
  }).catch(err => {
    console.error(`[pareto] service did not start: ${err?.message ?? err}`);
    if (globalThis[running]?.port === port) delete globalThis[running];
  });
  return {};
};
