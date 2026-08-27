import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { supabase } from "./lib/supabase";
import { useAuth } from "./hooks/useAuth";
import { Login } from "./components/Login";
import { PotCard } from "./components/PotCard";
import { ScreenshotUpload } from "./components/ScreenshotUpload";
import { DraftsReview } from "./components/DraftsReview";
import { OrderCosting } from "./components/OrderCosting";
import { ProductionCosts } from "./components/ProductionCosts";
import { AccountsPanel, deriveTotals } from "./components/AccountsPanel";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { EditableNumberInput } from "./components/EditableNumberInput";
import { fmt } from "./lib/format";
import type {
  BankAccount,
  BudgetAccount,
  BudgetDraft,
  BudgetItem,
  BudgetPot,
  PotWithItems,
  Project,
  ProjectRollup,
} from "./lib/types";

// These localStorage keys keep the studio_budget_ prefix from before the
// app was renamed to Ledger, on purpose. The deleted_pots and
// deleted_items keys hold a retry queue of deletes that have not yet been
// confirmed by the server. Renaming the keys would orphan that queue on
// every existing install, so those deletes would silently never retry.
// The keys are internal and never shown, so the stale name costs nothing.
const COLLAPSED_KEY = "studio_budget_collapsed_pots";
const SCENARIO_LABEL_KEY_PREFIX = "studio_budget_scenario_label";
const DELETED_POTS_KEY_PREFIX = "studio_budget_deleted_pots";
const DELETED_ITEMS_KEY_PREFIX = "studio_budget_deleted_items";
const LOCAL_REFETCH_GRACE_MS = 1200;

function readStoredIdSet(key: string): Set<string> {
  try {
    const saved = localStorage.getItem(key);
    return saved ? new Set<string>(JSON.parse(saved)) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function writeStoredIdSet(key: string, ids: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage errors so the app remains usable.
  }
}

// Number parsing and the editable input live in lib/numbers.ts and
// components/EditableNumberInput.tsx so the accounts and projects
// panels commit typed values exactly the way the pot editors do.

interface RebalanceMove {
  fromPotId: string;
  fromPotName: string;
  toPotId: string;
  toPotName: string;
  amount: number;
}

export default function App() {
  const { session, loading: authLoading } = useAuth();
  const [account, setAccount] = useState<BudgetAccount | null>(null);
  const [pots, setPots] = useState<PotWithItems[]>([]);
  const [drafts, setDrafts] = useState<BudgetDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedPots, setCollapsedPots] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(COLLAPSED_KEY);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [showProductionCosts, setShowProductionCosts] = useState(false);
  const [scenarioLabel, setScenarioLabel] = useState("");
  const scenarioLabelSelectOnFocus = useRef(true);

  // Migration 005 additions. These stay null or empty when the migration
  // has not been run, which is what stops a Vercel deploy from breaking
  // an installation whose database is still on 004. Every read below
  // tolerates a missing table rather than assuming one.
  const [bankAccounts, setBankAccounts] = useState<BankAccount[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rollups, setRollups] = useState<ProjectRollup[]>([]);
  const [predictionFactor, setPredictionFactor] = useState(1);
  const [closedJobCount, setClosedJobCount] = useState(0);

  // Pending writes — keyed by id, holding the latest patch waiting to flush
  const pendingAccountPatch = useRef<Partial<BudgetAccount> | null>(null);
  const pendingPotPatches = useRef<Map<string, Partial<BudgetPot>>>(new Map());
  const pendingItemPatches = useRef<Map<string, Partial<BudgetItem>>>(new Map());
  const pendingDeletedPotIds = useRef<Set<string>>(new Set());
  const pendingDeletedItemIds = useRef<Set<string>>(new Set());
  const flushTimer = useRef<number | null>(null);
  const lastLocalEditAt = useRef(0);

  const userId = session?.user.id;

  const scenarioLabelStorageKey = userId
    ? `${SCENARIO_LABEL_KEY_PREFIX}_${userId}`
    : SCENARIO_LABEL_KEY_PREFIX;
  const deletedPotsStorageKey = userId
    ? `${DELETED_POTS_KEY_PREFIX}_${userId}`
    : DELETED_POTS_KEY_PREFIX;
  const deletedItemsStorageKey = userId
    ? `${DELETED_ITEMS_KEY_PREFIX}_${userId}`
    : DELETED_ITEMS_KEY_PREFIX;

  const getDefaultScenarioLabel = useCallback((incomingDate?: string | null) => {
    const cleanIncomingDate = String(incomingDate ?? "").trim();
    if (!cleanIncomingDate) return "After incoming payment";
    return /^after\b/i.test(cleanIncomingDate)
      ? cleanIncomingDate
      : `After ${cleanIncomingDate}`;
  }, []);

  const markLocalEdit = useCallback(() => {
    lastLocalEditAt.current = Date.now();
  }, []);

  const hasPendingLocalWork = useCallback(() => {
    return (
      Boolean(pendingAccountPatch.current) ||
      pendingPotPatches.current.size > 0 ||
      pendingItemPatches.current.size > 0
    );
  }, []);

  const persistDeletedIds = useCallback(() => {
    if (!userId) return;
    writeStoredIdSet(deletedPotsStorageKey, pendingDeletedPotIds.current);
    writeStoredIdSet(deletedItemsStorageKey, pendingDeletedItemIds.current);
  }, [userId, deletedPotsStorageKey, deletedItemsStorageKey]);

  const loadDeletedIdsFromStorage = useCallback(() => {
    if (!userId) return;
    pendingDeletedPotIds.current = readStoredIdSet(deletedPotsStorageKey);
    pendingDeletedItemIds.current = readStoredIdSet(deletedItemsStorageKey);
  }, [userId, deletedPotsStorageKey, deletedItemsStorageKey]);

  const retryPersistedDeletes = useCallback(async () => {
    if (!userId) return;

    const itemIds = Array.from(pendingDeletedItemIds.current);
    for (const itemId of itemIds) {
      const { error } = await supabase
        .from("budget_items")
        .delete()
        .eq("id", itemId)
        .eq("user_id", userId);

      if (error) {
        console.error("Failed to delete item", error);
        continue;
      }

      const { data: stillExists } = await supabase
        .from("budget_items")
        .select("id")
        .eq("id", itemId)
        .eq("user_id", userId)
        .maybeSingle();

      if (!stillExists) {
        pendingDeletedItemIds.current.delete(itemId);
      }
    }

    const potIds = Array.from(pendingDeletedPotIds.current);
    for (const potId of potIds) {
      const { error: itemsError } = await supabase
        .from("budget_items")
        .delete()
        .eq("pot_id", potId)
        .eq("user_id", userId);

      const { error: potError } = await supabase
        .from("budget_pots")
        .delete()
        .eq("id", potId)
        .eq("user_id", userId);

      if (itemsError || potError) {
        console.error("Failed to delete pot", itemsError ?? potError);
        continue;
      }

      const { data: stillExists } = await supabase
        .from("budget_pots")
        .select("id")
        .eq("id", potId)
        .eq("user_id", userId)
        .maybeSingle();

      if (!stillExists) {
        pendingDeletedPotIds.current.delete(potId);
      }
    }

    persistDeletedIds();
  }, [userId, persistDeletedIds]);

  /**
   * Load the multi-account and project layer added in migration 005.
   *
   * If any of these tables are absent the app is running against a
   * database that has not been migrated yet. That is a supported state:
   * bankAccounts stays null, the legacy three-field account row renders
   * instead, and nothing throws. It means the frontend can deploy before
   * the migration is run, rather than the two having to land together.
   */
  const fetchProjectLayer = useCallback(async (uid: string) => {
    const { data: accountsData, error: accountsError } = await supabase
      .from("budget_bank_accounts")
      .select("*")
      .eq("user_id", uid)
      .order("sort_order", { ascending: true });

    if (accountsError) {
      setBankAccounts(null);
      setProjects([]);
      setRollups([]);
      return;
    }
    setBankAccounts(accountsData ?? []);

    const { data: projectsData } = await supabase
      .from("budget_projects")
      .select("*")
      .eq("user_id", uid)
      .order("sort_order", { ascending: true });
    setProjects(projectsData ?? []);

    const { data: rollupData } = await supabase
      .from("budget_project_rollup")
      .select("*")
      .eq("user_id", uid);
    setRollups(rollupData ?? []);

    const { data: factorData } = await supabase.rpc("budget_prediction_factor", {
      p_user_id: uid,
    });
    const factor = Number(factorData);
    setPredictionFactor(Number.isFinite(factor) && factor > 0 ? factor : 1);

    const { count } = await supabase
      .from("budget_order_quotes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .not("actual_production_cost", "is", null);
    setClosedJobCount(count ?? 0);
  }, []);

  const fetchAll = useCallback(async () => {
    if (!userId) return;

    loadDeletedIdsFromStorage();

    let { data: accountData } = await supabase
      .from("budget_accounts")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!accountData) {
      const { data: created } = await supabase
        .from("budget_accounts")
        .insert({ user_id: userId })
        .select()
        .single();
      accountData = created;
    }

    const { data: potsData } = await supabase
      .from("budget_pots")
      .select("*")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true });

    const { data: itemsData } = await supabase
      .from("budget_items")
      .select("*")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true });

    const accountSnapshot = accountData
      ? { ...accountData, ...(pendingAccountPatch.current ?? {}) }
      : accountData;

    const visiblePots = (potsData ?? []).filter(
      (pot: BudgetPot) => !pendingDeletedPotIds.current.has(pot.id)
    );

    const visibleItems = (itemsData ?? []).filter(
      (item: BudgetItem) =>
        !pendingDeletedItemIds.current.has(item.id) &&
        !pendingDeletedPotIds.current.has(item.pot_id)
    );

    const potsWithItems: PotWithItems[] = visiblePots.map((pot: BudgetPot) => {
      const pendingPotPatch = pendingPotPatches.current.get(pot.id) ?? {};
      return {
        ...pot,
        ...pendingPotPatch,
        items: visibleItems
          .filter((item: BudgetItem) => item.pot_id === pot.id)
          .map((item: BudgetItem) => ({
            ...item,
            ...(pendingItemPatches.current.get(item.id) ?? {}),
          })),
      };
    });

    const { data: draftsData } = await supabase
      .from("budget_drafts")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    setAccount(accountSnapshot);
    setPots(potsWithItems);
    setDrafts(draftsData ?? []);
    setLoading(false);

    await fetchProjectLayer(userId);
  }, [userId, loadDeletedIdsFromStorage, fetchProjectLayer]);

  useEffect(() => {
    if (!userId || !account) return;

    const savedLabel = localStorage.getItem(scenarioLabelStorageKey);
    setScenarioLabel(savedLabel ?? getDefaultScenarioLabel(account.incoming_date));
  }, [userId, account?.id, scenarioLabelStorageKey, getDefaultScenarioLabel]);

  useEffect(() => {
    if (!userId) return;
    loadDeletedIdsFromStorage();
    void retryPersistedDeletes();
  }, [userId, loadDeletedIdsFromStorage, retryPersistedDeletes]);

  useEffect(() => {
    if (userId) {
      setLoading(true);
      fetchAll();
    }
  }, [userId, fetchAll]);

  // Flush all pending writes to Supabase right now.
  // Patches are only removed permanently after Supabase confirms the save;
  // if a save fails, the app keeps the local patch and tries again later.
  const flushAll = useCallback(async () => {
    if (!userId) return;

    if (flushTimer.current) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }

    if (pendingAccountPatch.current && account) {
      const patch = pendingAccountPatch.current;
      pendingAccountPatch.current = null;

      const { error } = await supabase
        .from("budget_accounts")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", account.id)
        .eq("user_id", userId);

      if (error) {
        console.error("Failed to save account changes", error);
        pendingAccountPatch.current = { ...patch, ...(pendingAccountPatch.current ?? {}) };
      }
    }

    if (pendingPotPatches.current.size > 0) {
      const entries = Array.from(pendingPotPatches.current.entries());
      pendingPotPatches.current.clear();

      for (const [potId, patch] of entries) {
        const { error } = await supabase
          .from("budget_pots")
          .update(patch)
          .eq("id", potId)
          .eq("user_id", userId);

        if (error) {
          console.error("Failed to save pot changes", error);
          const existing = pendingPotPatches.current.get(potId) ?? {};
          pendingPotPatches.current.set(potId, { ...patch, ...existing });
        }
      }
    }

    if (pendingItemPatches.current.size > 0) {
      const entries = Array.from(pendingItemPatches.current.entries());
      pendingItemPatches.current.clear();

      for (const [itemId, patch] of entries) {
        const { error } = await supabase
          .from("budget_items")
          .update(patch)
          .eq("id", itemId)
          .eq("user_id", userId);

        if (error) {
          console.error("Failed to save item changes", error);
          const existing = pendingItemPatches.current.get(itemId) ?? {};
          pendingItemPatches.current.set(itemId, { ...patch, ...existing });
        }
      }
    }
  }, [account, userId]);

  // Schedule a single shared debounce that flushes everything together
  function scheduleFlush() {
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => {
      void flushAll();
    }, 500);
  }

  // Flush before tab close / app backgrounded / unmount
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flushAll();
      } else if (document.visibilityState === "visible") {
        // Returning to the tab — sync any changes from other windows
        void (async () => {
          await flushAll();
          fetchAll();
        })();
      }
    };
    const handleBeforeUnload = () => {
      void flushAll();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handleBeforeUnload);
      void flushAll();
    };
  }, [flushAll, fetchAll]);

  // Realtime subscription — any change to my budget data in another window pushes here
  useEffect(() => {
    if (!userId) return;

    let refetchTimer: number | null = null;

    const runRefetchWhenSafe = async () => {
      const recentlyEdited = Date.now() - lastLocalEditAt.current < LOCAL_REFETCH_GRACE_MS;

      if (hasPendingLocalWork() || recentlyEdited) {
        await flushAll();
        refetchTimer = window.setTimeout(() => {
          void runRefetchWhenSafe();
        }, LOCAL_REFETCH_GRACE_MS);
        return;
      }

      fetchAll();
    };

    const scheduleRefetch = () => {
      if (refetchTimer) window.clearTimeout(refetchTimer);
      // Small debounce so multiple rapid changes only trigger one refetch.
      // It waits until local typing/deletes have settled so Supabase realtime
      // cannot overwrite in-progress input values.
      refetchTimer = window.setTimeout(() => {
        void runRefetchWhenSafe();
      }, 600);
    };

    const channel = supabase
      .channel(`budget_sync_${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "budget_accounts", filter: `user_id=eq.${userId}` },
        scheduleRefetch
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "budget_pots", filter: `user_id=eq.${userId}` },
        scheduleRefetch
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "budget_items", filter: `user_id=eq.${userId}` },
        scheduleRefetch
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "budget_drafts", filter: `user_id=eq.${userId}` },
        scheduleRefetch
      )
      .subscribe();

    return () => {
      if (refetchTimer) window.clearTimeout(refetchTimer);
      void supabase.removeChannel(channel);
    };
  }, [userId, flushAll, fetchAll, hasPendingLocalWork]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedPots]));
  }, [collapsedPots]);

  // Calculations + rebalancing — derived state via useMemo so they recompute optimistically
  const { totalNeeded, surplus, shortfalls, rebalanceMoves, residualShortfalls } = useMemo(() => {
    let totalNeeded = 0;
    const surplus: { id: string; name: string; amount: number }[] = [];
    const shortfalls: { id: string; name: string; amount: number }[] = [];

    pots.forEach((pot) => {
      const potTotal = pot.items.reduce((s, i) => s + Number(i.amount), 0);
      totalNeeded += potTotal;
      const diff = Number(pot.current_balance) - potTotal;
      if (diff > 0) surplus.push({ id: pot.id, name: pot.name, amount: diff });
      else if (diff < 0) shortfalls.push({ id: pot.id, name: pot.name, amount: Math.abs(diff) });
    });

    // Greedy match: largest surplus pays largest shortfall first
    const surplusQueue = [...surplus].sort((a, b) => b.amount - a.amount);
    const shortfallQueue = [...shortfalls].sort((a, b) => b.amount - a.amount);
    const moves: RebalanceMove[] = [];

    for (const sf of shortfallQueue) {
      let remaining = sf.amount;
      while (remaining > 0.005 && surplusQueue.length > 0) {
        const sp = surplusQueue[0];
        const move = Math.min(sp.amount, remaining);
        moves.push({
          fromPotId: sp.id,
          fromPotName: sp.name,
          toPotId: sf.id,
          toPotName: sf.name,
          amount: move,
        });
        sp.amount -= move;
        remaining -= move;
        if (sp.amount <= 0.005) surplusQueue.shift();
      }
      if (remaining > 0.005) {
        // residual shortfall after rebalancing
        sf.amount = remaining;
      } else {
        sf.amount = 0;
      }
    }

    const residualShortfalls = shortfallQueue.filter((s) => s.amount > 0.005);

    return { totalNeeded, surplus, shortfalls, rebalanceMoves: moves, residualShortfalls };
  }, [pots]);

  const totalResidualShortfall = residualShortfalls.reduce((s, x) => s + x.amount, 0);

  if (authLoading) return <div className="loading">Loading...</div>;
  if (!session) return <Login />;
  if (loading || !account) return <div className="loading">Loading your budget...</div>;

  // The rebalance maths needs three figures: the account transfers are
  // pulled from, a secondary buffer held outside the pots, and money
  // that is owed but not yet in. Before migration 005 those were three
  // fixed columns. Now they are derived by role from however many
  // accounts exist, with the old columns as the fallback.
  // Outstanding studio hours: the same rule as committed money, so ticking an
  // item off clears its hours in the same gesture. No second thing to maintain.
  const outstandingHours = pots.reduce(
    (sum, pot) =>
      sum +
      pot.items.reduce(
        (s, i) => s + (i.paid ? 0 : Number(i.hours ?? 0)),
        0
      ),
    0
  );

  const derived = bankAccounts ? deriveTotals(bankAccounts) : null;
  const primaryBalance = derived
    ? derived.primaryBalance
    : Number(account.hsbc_balance);
  const bufferBalance = derived
    ? derived.bufferBalance
    : Number(account.monzo_main_balance);
  const incomingBalance = derived
    ? derived.incoming
    : Number(account.incoming_amount);

  const effectivePrimary =
    account.scenario === "with"
      ? primaryBalance + incomingBalance
      : primaryBalance;
  const transferFromHSBC = Math.max(0, totalResidualShortfall - bufferBalance);
  const monzoMainUsed = Math.min(bufferBalance, totalResidualShortfall);
  const hsbcAfter = effectivePrimary - transferFromHSBC;

  // Optimistic local updaters — UI updates immediately, DB writes batched + flushed
  function updateAccountLocal(patch: Partial<BudgetAccount>) {
    markLocalEdit();
    setAccount((prev) => (prev ? { ...prev, ...patch } : prev));
    pendingAccountPatch.current = { ...(pendingAccountPatch.current ?? {}), ...patch };
    scheduleFlush();
  }

  function updateScenarioLabelLocal(value: string) {
    markLocalEdit();
    setScenarioLabel(value);
    localStorage.setItem(scenarioLabelStorageKey, value);
  }

  function handleScenarioLabelFocus(event: FocusEvent<HTMLInputElement>) {
    setScenario("with");
    if (scenarioLabelSelectOnFocus.current) {
      event.currentTarget.select();
      scenarioLabelSelectOnFocus.current = false;
    }
  }

  function setScenario(scenario: "with" | "without") {
    updateAccountLocal({ scenario });
  }

  async function addPot() {
    if (!userId) return;
    markLocalEdit();
    const nextSort = (pots.at(-1)?.sort_order ?? 0) + 1;
    const { data } = await supabase
      .from("budget_pots")
      .insert({
        user_id: userId,
        name: "New pot",
        current_balance: 0,
        sort_order: nextSort,
      })
      .select()
      .single();
    if (data) setPots((prev) => [...prev, { ...data, items: [] }]);
  }

  function updatePotLocal(potId: string, patch: Partial<BudgetPot>) {
    markLocalEdit();
    setPots((prev) => prev.map((p) => (p.id === potId ? { ...p, ...patch } : p)));
    const existing = pendingPotPatches.current.get(potId) ?? {};
    pendingPotPatches.current.set(potId, { ...existing, ...patch });
    scheduleFlush();
  }

  async function deletePotLocal(potId: string) {
    if (!userId) return;

    markLocalEdit();
    pendingPotPatches.current.delete(potId);
    pendingDeletedPotIds.current.add(potId);

    const itemIds = pots.find((p) => p.id === potId)?.items.map((item) => item.id) ?? [];
    itemIds.forEach((itemId) => {
      pendingItemPatches.current.delete(itemId);
      pendingDeletedItemIds.current.add(itemId);
    });

    persistDeletedIds();

    setPots((prev) => prev.filter((p) => p.id !== potId));
    setCollapsedPots((prev) => {
      const next = new Set(prev);
      next.delete(potId);
      return next;
    });

    const { error: itemsError } = await supabase
      .from("budget_items")
      .delete()
      .eq("pot_id", potId)
      .eq("user_id", userId);

    const { error: potError } = await supabase
      .from("budget_pots")
      .delete()
      .eq("id", potId)
      .eq("user_id", userId);

    if (itemsError || potError) {
      console.error("Failed to delete pot", itemsError ?? potError);
      persistDeletedIds();
      return;
    }

    const { data: stillExists } = await supabase
      .from("budget_pots")
      .select("id")
      .eq("id", potId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!stillExists) {
      pendingDeletedPotIds.current.delete(potId);
      itemIds.forEach((itemId) => pendingDeletedItemIds.current.delete(itemId));
      persistDeletedIds();
      return;
    }

    persistDeletedIds();
  }

  async function addItemToPot(potId: string): Promise<BudgetItem | null> {
    if (!userId) return null;
    markLocalEdit();
    const pot = pots.find((p) => p.id === potId);
    const nextSort = (pot?.items.at(-1)?.sort_order ?? 0) + 1;
    const { data } = await supabase
      .from("budget_items")
      .insert({
        pot_id: potId,
        user_id: userId,
        label: "New item",
        amount: 0,
        sort_order: nextSort,
      })
      .select()
      .single();
    if (data) {
      setPots((prev) =>
        prev.map((p) => (p.id === potId ? { ...p, items: [...p.items, data] } : p))
      );
      return data;
    }
    return null;
  }

  function updateItemLocal(potId: string, itemId: string, patch: Partial<BudgetItem>) {
    markLocalEdit();
    setPots((prev) =>
      prev.map((p) =>
        p.id === potId
          ? { ...p, items: p.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }
          : p
      )
    );
    const existing = pendingItemPatches.current.get(itemId) ?? {};
    pendingItemPatches.current.set(itemId, { ...existing, ...patch });
    scheduleFlush();
  }

  async function deleteItemLocal(potId: string, itemId: string) {
    if (!userId) return;

    markLocalEdit();
    pendingItemPatches.current.delete(itemId);
    pendingDeletedItemIds.current.add(itemId);
    persistDeletedIds();

    setPots((prev) =>
      prev.map((p) =>
        p.id === potId ? { ...p, items: p.items.filter((i) => i.id !== itemId) } : p
      )
    );

    const { error } = await supabase
      .from("budget_items")
      .delete()
      .eq("id", itemId)
      .eq("user_id", userId);

    if (error) {
      console.error("Failed to delete item", error);
      persistDeletedIds();
      return;
    }

    const { data: stillExists } = await supabase
      .from("budget_items")
      .select("id")
      .eq("id", itemId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!stillExists) {
      pendingDeletedItemIds.current.delete(itemId);
    }

    persistDeletedIds();
  }

  async function applyRebalanceMoves() {
    if (rebalanceMoves.length === 0) return;
    await flushAll();

    // Aggregate net changes per pot
    const deltas = new Map<string, number>();
    for (const m of rebalanceMoves) {
      deltas.set(m.fromPotId, (deltas.get(m.fromPotId) ?? 0) - m.amount);
      deltas.set(m.toPotId, (deltas.get(m.toPotId) ?? 0) + m.amount);
    }

    // Optimistic local update
    setPots((prev) =>
      prev.map((p) => {
        const delta = deltas.get(p.id);
        if (delta === undefined) return p;
        return { ...p, current_balance: Number(p.current_balance) + delta };
      })
    );

    // Persist
    for (const [potId, delta] of deltas) {
      const pot = pots.find((p) => p.id === potId);
      if (!pot) continue;
      const newBalance = Number(pot.current_balance) + delta;
      void supabase.from("budget_pots").update({ current_balance: newBalance }).eq("id", potId);
    }
  }

  function togglePotCollapse(potId: string) {
    setCollapsedPots((prev) => {
      const next = new Set(prev);
      if (next.has(potId)) next.delete(potId);
      else next.add(potId);
      return next;
    });
  }

  function expandAll() {
    setCollapsedPots(new Set());
  }

  function collapseAll() {
    setCollapsedPots(new Set(pots.map((p) => p.id)));
  }

  async function signOut() {
    await flushAll();
    await supabase.auth.signOut();
  }

  const allCollapsed = pots.length > 0 && pots.every((p) => collapsedPots.has(p.id));
  const totalSurplus = surplus.reduce((s, x) => s + x.amount, 0);
  const totalShortfallBeforeRebalance = shortfalls.reduce((s, x) => s + x.amount, 0);
  const incomingScenarioLabel = scenarioLabel.trim() || "After incoming payment";

  return (
    <div className="app-shell">
      <div className="header">
        <h1>Ledger</h1>
        <div className="header-actions">
          <button onClick={async () => { await flushAll(); setShowProductionCosts(true); }}>Rate card</button>
          <button onClick={allCollapsed ? expandAll : collapseAll}>
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
          <button onClick={signOut}>Sign out</button>
        </div>
      </div>

      {bankAccounts !== null && userId ? (
        <AccountsPanel
          accounts={bankAccounts}
          userId={userId}
          onChanged={() => fetchProjectLayer(userId)}
        />
      ) : (
      <div className="accounts-row">
        <div className="account-box">
          <div className="account-label">HSBC balance</div>
          <EditableNumberInput
            className="account-input"
            value={account.hsbc_balance}
            onValueChange={(value) => updateAccountLocal({ hsbc_balance: value })}
          />
        </div>
        <div className="account-box">
          <div className="account-label">Monzo main</div>
          <EditableNumberInput
            className="account-input"
            value={account.monzo_main_balance}
            onValueChange={(value) => updateAccountLocal({ monzo_main_balance: value })}
          />
          <div className="account-sub">Outside pots</div>
        </div>
        <div className="account-box incoming">
          <div className="account-label">+ Incoming payment</div>
          <EditableNumberInput
            className="account-input"
            value={account.incoming_amount}
            onValueChange={(value) => updateAccountLocal({ incoming_amount: value })}
          />
          <div className="account-sub">Click the black tab below to rename this scenario</div>
        </div>
      </div>
      )}

      <div className="scenario-tabs">
        <button
          className={`scenario-tab ${account.scenario === "without" ? "active" : ""}`}
          onClick={() => setScenario("without")}
        >
          Now (primary only)
        </button>
        <input
          className={`scenario-tab ${account.scenario === "with" ? "active" : ""}`}
          type="text"
          aria-label="Edit incoming payment scenario label"
          title="Click to rename this scenario"
          value={scenarioLabel}
          placeholder="After incoming payment"
          onFocus={handleScenarioLabelFocus}
          onBlur={() => {
            scenarioLabelSelectOnFocus.current = true;
            if (!scenarioLabel.trim()) updateScenarioLabelLocal("After incoming payment");
          }}
          onChange={(e) => updateScenarioLabelLocal(e.target.value)}
          style={{
            border: "none",
            textAlign: "center",
            cursor: "text",
            minWidth: 190,
          }}
        />
      </div>

      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-label">Total costs</div>
          <div className="summary-value">{fmt(totalNeeded)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Surplus across pots</div>
          <div className="summary-value">{fmt(totalSurplus)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Shortfall across pots</div>
          <div className="summary-value">{fmt(totalShortfallBeforeRebalance)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Studio hours outstanding</div>
          <div className="summary-value">
            {outstandingHours % 1 === 0
              ? outstandingHours
              : outstandingHours.toFixed(1)}
            h
          </div>
          {outstandingHours > 0 && (
            <div className="summary-sub">
              about {Math.ceil(outstandingHours / 6)} full bench{" "}
              {Math.ceil(outstandingHours / 6) === 1 ? "day" : "days"}
            </div>
          )}
        </div>
        <div className="summary-card">
          <div className="summary-label">HSBC after transfer</div>
          <div
            className="summary-value"
            style={{ color: hsbcAfter < 0 ? "var(--danger-text)" : "var(--text)" }}
          >
            {hsbcAfter < 0 ? "−" : ""}
            {fmt(hsbcAfter)}
          </div>
        </div>
      </div>

      {bankAccounts !== null && userId && (
        <ProjectsPanel
          projects={projects}
          rollups={rollups}
          predictionFactor={predictionFactor}
          closedJobCount={closedJobCount}
          userId={userId}
          onChanged={() => fetchProjectLayer(userId)}
        />
      )}

      <ScreenshotUpload onParsed={async () => { await flushAll(); fetchAll(); }} />

      <OrderCosting pots={pots} onCommitted={async () => { await flushAll(); fetchAll(); }} />

      <DraftsReview drafts={drafts} pots={pots} onAccepted={async () => { await flushAll(); fetchAll(); }} />

      {rebalanceMoves.length > 0 && (
        <div className="rebalance-section">
          <div className="rebalance-header">
            <div>
              <div className="rebalance-title">Suggested pot rebalancing</div>
              <div className="rebalance-subtitle">
                Some pots are overfunded. Move that surplus to cover shortfalls before pulling from HSBC.
              </div>
            </div>
            <button className="rebalance-apply" onClick={applyRebalanceMoves}>
              Apply all
            </button>
          </div>
          {rebalanceMoves.map((m, i) => (
            <div key={i} className="rebalance-row">
              <span>
                <strong>{m.fromPotName}</strong>
                <span className="rebalance-arrow"> → </span>
                <strong>{m.toPotName}</strong>
              </span>
              <span style={{ fontWeight: 500 }}>{fmt(m.amount)}</span>
            </div>
          ))}
          <div className="rebalance-total">
            <span>Total internal moves</span>
            <span>{fmt(rebalanceMoves.reduce((s, m) => s + m.amount, 0))}</span>
          </div>
        </div>
      )}

      {pots.map((pot) => (
        <PotCard
          key={pot.id}
          pot={pot}
          collapsed={collapsedPots.has(pot.id)}
          onToggleCollapse={() => togglePotCollapse(pot.id)}
          onUpdatePot={(patch) => updatePotLocal(pot.id, patch)}
          onDeletePot={() => { void deletePotLocal(pot.id); }}
          onAddItem={() => addItemToPot(pot.id)}
          onUpdateItem={(itemId, patch) => updateItemLocal(pot.id, itemId, patch)}
          onDeleteItem={(itemId) => { void deleteItemLocal(pot.id, itemId); }}
        />
      ))}

      <button className="add-pot-btn" onClick={addPot}>
        + Add new pot
      </button>

      {residualShortfalls.length > 0 && (
        <div className="transfer-section">
          <div className="transfer-title">
            Transfer from HSBC — {account.scenario === "with" ? incomingScenarioLabel : "today"}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
            After rebalancing surplus pots, these still need topping up from outside Monzo:
          </div>
          {bufferBalance > 0 && totalResidualShortfall > 0 && (
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
              Use {fmt(monzoMainUsed)} from your buffer accounts first, then transfer{" "}
              {fmt(transferFromHSBC)} from the primary account
            </div>
          )}
          {residualShortfalls.map((sf) => (
            <div className="transfer-row" key={sf.id}>
              <span>{sf.name} top-up</span>
              <span style={{ fontWeight: 500 }}>{fmt(sf.amount)}</span>
            </div>
          ))}
          <div className="transfer-total">
            <span>Total external top-ups</span>
            <span>{fmt(totalResidualShortfall)}</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 8 }}>
            HSBC{" "}
            {account.scenario === "with" ? "after incoming + transfer" : "after transfer"}:{" "}
            {hsbcAfter < 0 ? "−" : ""}
            {fmt(hsbcAfter)}
          </div>
          {hsbcAfter < 0 && (
            <>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--danger-text)",
                  marginTop: 4,
                  fontWeight: 500,
                }}
              >
                ⚠ Shortfall of {fmt(Math.abs(hsbcAfter))}
              </div>
              {/* Reserves are excluded from available on purpose, but staying
                  silent about them when short just makes the user do the
                  arithmetic. Name the option, do not take it for them. */}
              {derived && derived.reserves > 0 && (
                <div style={{ fontSize: 13, color: "var(--info-text)", marginTop: 4 }}>
                  {derived.reserves >= Math.abs(hsbcAfter)
                    ? `Your reserve holds ${fmt(derived.reserves)}, which would cover this and leave ${fmt(derived.reserves - Math.abs(hsbcAfter))}. Reserves are held back deliberately, so this is a decision rather than a suggestion.`
                    : `Your reserve holds ${fmt(derived.reserves)}, which would not close the gap on its own. ${fmt(Math.abs(hsbcAfter) - derived.reserves)} would still be short.`}
                </div>
              )}
              {account.scenario === "without" &&
                Math.abs(hsbcAfter) <= incomingBalance && (
                  <div style={{ fontSize: 13, color: "var(--info-text)", marginTop: 4 }}>
                    The incoming payment ({incomingScenarioLabel}) of{" "}
                    {fmt(incomingBalance)} will cover this
                  </div>
                )}
            </>
          )}
        </div>
      )}

      {residualShortfalls.length === 0 && rebalanceMoves.length > 0 && (
        <div
          className="transfer-section"
          style={{ background: "var(--success-bg)", color: "var(--success-text)" }}
        >
          <div className="transfer-title" style={{ color: "var(--success-text)" }}>
            All shortfalls covered by rebalancing
          </div>
          <div style={{ fontSize: 13 }}>
            No external transfers needed once the pot moves above are applied.
          </div>
        </div>
      )}

      {showProductionCosts && (
        <ProductionCosts
          pots={pots}
          projects={projects}
          onAdded={fetchAll}
          onClose={() => setShowProductionCosts(false)}
        />
      )}
    </div>
  );
}
