/**
 * Paseo API type used by server lifecycle hooks and RPC handlers, which receive
 * it through their context. Derived from the plugin SDK so plugin code does not
 * depend on @getpaseo/client directly.
 */
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];
