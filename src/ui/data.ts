// Data hooks for the app: RPC calls kept fresh by the server's
// `rewind.changed` realtime signal and by reconnects.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginRpcClient, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL } from "../constants";
import type { RpcContract } from "../rpc-contract";
import { errorMessage } from "./labels";

export type Rpc = PluginRpcClient<RpcContract>;
export type ListResult = PluginRpcResult<RpcContract["list"]>;
export type SummaryResult = PluginRpcResult<RpcContract["summary"]>;
export type PreviewResult = PluginRpcResult<RpcContract["preview"]>;
export type DiffResult = PluginRpcResult<RpcContract["diff"]>;
export type ResolveResult = PluginRpcResult<RpcContract["resolveMessage"]>;
export type RestoreOutcomeResult = PluginRpcResult<RpcContract["restore"]>;
export type ForkJobResult = PluginRpcResult<RpcContract["forkStatus"]>["job"];

export function useRewindRpc(): Rpc {
  return useRpc<RpcContract>();
}

/** Calls `onChange` when the server says this thread's checkpoints changed. */
export function useThreadChanges(threadId: string, onChange: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useRealtime(CHANGED_CHANNEL, (payload: unknown) => {
    const changed = typeof payload === "object" && payload !== null && "threadId" in payload ? (payload as { threadId: unknown }).threadId : null;
    if (changed === threadId) latest.current();
  });
  // Signals are not replayed: refetch after a reconnect (not the first connect).
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") latest.current();
    previous.current = connection;
  }, [connection]);
}

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  requestId: number;
  /** Live check, including invalidation before React commits another render. */
  isCurrent: () => boolean;
}

/** Load with `fetcher`; reload on thread changes. Stale responses are dropped. */
export function useLoadable<T>(threadId: string, fetcher: () => Promise<T>, key: string): Loadable<T> {
  const identity = JSON.stringify([threadId, key]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [state, setState] = useState<{ identity: string; requestId: number; data: T | null; error: string | null; loading: boolean }>({ identity, requestId: 0, data: null, error: null, loading: true });
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const reload = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    const requestIdentity = identityRef.current;
    setState({ identity: requestIdentity, requestId: mine, data: null, error: null, loading: true });
    fetcherRef.current().then(
      (value) => {
        if (mine !== generation.current || requestIdentity !== identityRef.current) return;
        setState({ identity: requestIdentity, requestId: mine, data: value, error: null, loading: false });
      },
      (cause: unknown) => {
        if (mine !== generation.current || requestIdentity !== identityRef.current) return;
        setState({ identity: requestIdentity, requestId: mine, data: null, error: errorMessage(cause), loading: false });
      },
    );
  }, []);
  useEffect(() => {
    reload();
    return () => {
      generation.current += 1;
    };
  }, [reload, threadId, key]);
  useThreadChanges(threadId, reload);
  // Suppress mismatches during render, before the key-change effect runs.
  const matching = state.identity === identity && state.requestId === generation.current;
  const isCurrent = () => state.identity === identityRef.current && state.requestId === generation.current && !state.loading && state.error === null && state.data !== null;
  return { data: matching ? state.data : null, error: matching ? state.error : null, loading: !matching || state.loading, reload, requestId: generation.current, isCurrent };
}
