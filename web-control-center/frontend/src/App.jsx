import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ATTENTION_BUCKETS,
  STATUS_BUCKETS,
  STATUS_LABELS,
  compareResources,
  summarize,
} from './status.js';
import VpsPanel from './VpsPanel.jsx';

const POLL_INTERVAL_MS = 15000;
const POLL_BACKOFF_MAX_MS = 120000;
const AUDIT_INTERVAL_MS = 30000;
const LOG_INTERVAL_MS = 20000;

const STORAGE_KEYS = {
  query: 'cc.query',
  selectedProject: 'cc.selectedProject',
  pinned: 'cc.pinned',
  compareMode: 'cc.compareMode',
  compareSlots: 'cc.compareSlots',
  token: 'cc.auth.token',
};

const DESTRUCTIVE_ACTIONS = new Set(['stop', 'restart', 'deploy']);

function prettyType(type) {
  if (type === 'application') return 'Aplicacao';
  if (type === 'service') return 'Servico';
  if (type === 'database') return 'Banco';
  return type;
}

function resourceKey(resource) {
  if (!resource) return '';
  return `${resource.type}:${resource.uuid}`;
}

function canExecuteAction(resourceType, action) {
  const allowedTypes = new Set(['application', 'service', 'database']);
  const allowedActions = new Set(['start', 'stop', 'restart', 'deploy']);

  if (!allowedTypes.has(resourceType) || !allowedActions.has(action)) {
    return false;
  }

  if (action === 'deploy' && resourceType !== 'application') {
    return false;
  }

  return true;
}

function groupLogsByContainer(rawLogs) {
  const text = String(rawLogs || '');
  if (!text.trim()) {
    return [];
  }

  const lines = text.split('\n');
  const groups = new Map();

  lines.forEach((line, index) => {
    const composeMatch = line.match(/^([a-zA-Z0-9_.-]+)\s+\|\s?(.*)$/);
    const bracketMatch = line.match(/^\[([^\]]+)\]\s?(.*)$/);

    let key = 'application';
    let message = line;

    if (composeMatch) {
      key = composeMatch[1];
      message = composeMatch[2];
    } else if (bracketMatch) {
      key = bracketMatch[1];
      message = bracketMatch[2];
    }

    const current = groups.get(key) || [];
    // Keep the original line number so chronology is not lost when regrouping.
    current.push({ index, message });
    groups.set(key, current);
  });

  return Array.from(groups.entries())
    .map(([name, chunk]) => ({
      name,
      lines: chunk.length,
      firstLine: chunk[0]?.index ?? 0,
      logs: chunk.map((item) => item.message).join('\n').trim(),
    }))
    .sort((a, b) => a.firstLine - b.firstLine);
}

function readStorage(key, fallbackValue) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallbackValue;
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore localStorage errors.
  }
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Falha HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function formatClock(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR');
}

function useControlCenterData({ authToken, onUnauthorized }) {
  const [projects, setProjects] = useState([]);
  const [resources, setResources] = useState({
    applications: [],
    services: [],
    databases: [],
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastSuccessAt, setLastSuccessAt] = useState('');

  // Refs keep the polling loop stable: it must not be rebuilt on every render.
  const authTokenRef = useRef(authToken);
  const failureCountRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  const apiFetch = useCallback(
    async (path, options = {}) => {
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      };

      const token = authTokenRef.current;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(path, { ...options, headers });

      if (response.status === 401) {
        onUnauthorized();
      }

      return parseResponse(response);
    },
    [onUnauthorized]
  );

  const refresh = useCallback(async () => {
    try {
      const [projectJson, resourceJson] = await Promise.all([
        apiFetch('/api/projects'),
        apiFetch('/api/resources'),
      ]);

      setProjects(projectJson.projects || []);
      setResources({
        applications: resourceJson.applications || [],
        services: resourceJson.services || [],
        databases: resourceJson.databases || [],
      });
      setError('');
      setLastSuccessAt(resourceJson.fetchedAt || new Date().toISOString());
      failureCountRef.current = 0;
    } catch (fetchError) {
      failureCountRef.current += 1;
      setError(fetchError.message || 'Erro ao carregar dados.');
      throw fetchError;
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  /**
   * Self-scheduling poll loop.
   *
   * Backs off exponentially while the API is failing instead of hammering a
   * struggling VPS every few seconds, and pauses entirely when the tab is
   * hidden — nobody is reading the screen anyway.
   */
  useEffect(() => {
    if (!authToken) {
      return undefined;
    }

    let cancelled = false;
    // Guards against two concurrent poll chains: waking the tab used to start
    // a new tick while the previous one was still awaiting, and both would
    // then reschedule themselves.
    let running = false;

    const scheduleNext = () => {
      if (cancelled) return;
      const failures = failureCountRef.current;
      const delay =
        failures === 0
          ? POLL_INTERVAL_MS
          : Math.min(POLL_INTERVAL_MS * 2 ** failures, POLL_BACKOFF_MAX_MS);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (cancelled || running) return;
      if (document.hidden) {
        scheduleNext();
        return;
      }

      running = true;
      try {
        await refresh();
      } catch {
        // Error state is already surfaced; backoff handles the retry pace.
      } finally {
        running = false;
      }
      scheduleNext();
    };

    tick();

    const onVisible = () => {
      if (!document.hidden && !cancelled && !running) {
        clearTimeout(timerRef.current);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authToken, refresh]);

  return { projects, resources, loading, error, lastSuccessAt, refresh, apiFetch };
}

export default function App() {
  const [authResolved, setAuthResolved] = useState(false);
  const [authToken, setAuthToken] = useState(() => readStorage(STORAGE_KEYS.token, ''));
  const [actor, setActor] = useState('');
  const [loginUser, setLoginUser] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [loginPending, setLoginPending] = useState(false);

  const [query, setQuery] = useState(() => readStorage(STORAGE_KEYS.query, ''));
  const [selectedProject, setSelectedProject] = useState(
    () => readStorage(STORAGE_KEYS.selectedProject, 'all') || 'all'
  );
  const [tabs, setTabs] = useState([
    { id: 'all', label: 'Visao Geral' },
    { id: 'infra', label: 'Infraestrutura' },
  ]);
  const [activeTab, setActiveTab] = useState('all');
  const [events, setEvents] = useState([]);
  const [pendingAction, setPendingAction] = useState('');
  const [pinSet, setPinSet] = useState(() => new Set(readStorage(STORAGE_KEYS.pinned, [])));
  const [batchSelected, setBatchSelected] = useState(new Set());
  const [batchAction, setBatchAction] = useState('restart');
  const [batchPending, setBatchPending] = useState(false);
  const [confirmation, setConfirmation] = useState(null);

  const [selectedResource, setSelectedResource] = useState(null);
  const [logTab, setLogTab] = useState('runtime');
  const [runtimeLogs, setRuntimeLogs] = useState('');
  const [isLoadingRuntimeLogs, setIsLoadingRuntimeLogs] = useState(false);
  const [applicationLogs, setApplicationLogs] = useState('');
  const [applicationLogMeta, setApplicationLogMeta] = useState(null);
  const [applicationContainerLogs, setApplicationContainerLogs] = useState([]);
  const [isLoadingApplicationLogs, setIsLoadingApplicationLogs] = useState(false);
  const [applicationLogHistory, setApplicationLogHistory] = useState([]);
  const [isLoadingApplicationLogHistory, setIsLoadingApplicationLogHistory] = useState(false);
  const [auditEntries, setAuditEntries] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const [compareMode, setCompareMode] = useState(() =>
    Boolean(readStorage(STORAGE_KEYS.compareMode, false))
  );
  const [compareSlots, setCompareSlots] = useState([null, null]);
  const [compareLogState, setCompareLogState] = useState({});
  const [savedCompareSlotKeys] = useState(() =>
    readStorage(STORAGE_KEYS.compareSlots, [null, null])
  );

  const clearAuthorization = useCallback(() => {
    setAuthToken('');
    setActor('');
    writeStorage(STORAGE_KEYS.token, '');
  }, []);

  const { projects, resources, loading, error, lastSuccessAt, refresh, apiFetch } =
    useControlCenterData({ authToken, onUnauthorized: clearAuthorization });

  const isAuthorized = Boolean(authToken);

  const allResources = useMemo(
    () => [...resources.applications, ...resources.services, ...resources.databases],
    [resources]
  );

  const resourcesByKey = useMemo(
    () => new Map(allResources.map((item) => [resourceKey(item), item])),
    [allResources]
  );

  const scopedResources = useMemo(() => {
    let items = allResources;
    if (selectedProject !== 'all') {
      items = items.filter((item) => item.project === selectedProject);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      items = items.filter(
        (item) =>
          item.name?.toLowerCase().includes(q) ||
          item.description?.toLowerCase().includes(q) ||
          item.environment?.toLowerCase().includes(q) ||
          item.project?.toLowerCase().includes(q)
      );
    }

    return [...items].sort(compareResources);
  }, [allResources, selectedProject, query]);

  const summary = useMemo(() => summarize(scopedResources), [scopedResources]);

  const attentionCount = useMemo(
    () =>
      STATUS_BUCKETS.filter((bucket) => ATTENTION_BUCKETS.has(bucket)).reduce(
        (total, bucket) => total + (summary[bucket] || 0),
        0
      ),
    [summary]
  );

  const pinnedResources = scopedResources.filter((item) => pinSet.has(resourceKey(item)));

  const compareSet = useMemo(() => {
    const keys = compareSlots.filter(Boolean).map((item) => resourceKey(item));
    return new Set(keys);
  }, [compareSlots]);

  const pushEvent = useCallback((level, message) => {
    setEvents((prev) => [
      {
        id: `${Date.now()}-${Math.random()}`,
        level,
        message,
        timestamp: new Date().toISOString(),
      },
      ...prev.slice(0, 199),
    ]);
  }, []);

  useEffect(() => {
    // Auth is mandatory server-side; we only need to know whether the stored
    // token is still valid before showing the dashboard.
    async function bootstrapAuth() {
      const token = readStorage(STORAGE_KEYS.token, '');
      if (!token) {
        setAuthResolved(true);
        return;
      }

      try {
        const response = await fetch('/api/session', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await parseResponse(response);
        setActor(payload.actor || '');
      } catch {
        clearAuthorization();
      } finally {
        setAuthResolved(true);
      }
    }

    bootstrapAuth();
  }, [clearAuthorization]);

  useEffect(() => writeStorage(STORAGE_KEYS.query, query), [query]);
  useEffect(() => writeStorage(STORAGE_KEYS.selectedProject, selectedProject), [selectedProject]);
  useEffect(() => writeStorage(STORAGE_KEYS.compareMode, compareMode), [compareMode]);
  useEffect(() => writeStorage(STORAGE_KEYS.pinned, Array.from(pinSet)), [pinSet]);
  useEffect(() => writeStorage(STORAGE_KEYS.token, authToken || ''), [authToken]);

  useEffect(() => {
    const keys = compareSlots.map((item) => (item ? resourceKey(item) : null));
    writeStorage(STORAGE_KEYS.compareSlots, keys);
  }, [compareSlots]);

  useEffect(() => {
    if (allResources.length === 0) {
      return;
    }

    setCompareSlots((prev) => {
      const hasActiveSlots = prev.some(Boolean);
      if (!hasActiveSlots && savedCompareSlotKeys.some(Boolean)) {
        return savedCompareSlotKeys.map((key) => (key ? resourcesByKey.get(key) || null : null));
      }

      return prev.map((item) => (item ? resourcesByKey.get(resourceKey(item)) || null : null));
    });

    setBatchSelected((prev) => {
      const next = new Set();
      prev.forEach((key) => {
        if (resourcesByKey.has(key)) {
          next.add(key);
        }
      });
      return next;
    });
  }, [allResources, resourcesByKey, savedCompareSlotKeys]);

  const fetchAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const payload = await apiFetch('/api/audit?take=120');
      setAuditEntries(payload.entries || []);
    } catch (auditError) {
      pushEvent('error', `[AUDIT] ${auditError.message || 'Falha ao carregar auditoria.'}`);
    } finally {
      setAuditLoading(false);
    }
  }, [apiFetch, pushEvent]);

  useEffect(() => {
    if (!isAuthorized) {
      return undefined;
    }

    fetchAudit();
    const timer = setInterval(() => {
      if (!document.hidden) {
        fetchAudit();
      }
    }, AUDIT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isAuthorized, fetchAudit]);

  function addTab(projectName) {
    const tabId = `project:${projectName}`;
    if (!tabs.some((tab) => tab.id === tabId)) {
      setTabs((prev) => [...prev, { id: tabId, label: projectName }]);
    }
    setActiveTab(tabId);
    setSelectedProject(projectName);
  }

  function closeTab(tabId) {
    // "all" and "infra" are permanent tabs, not workspaces.
    if (tabId === 'all' || tabId === 'infra') return;
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    if (activeTab === tabId) {
      setActiveTab('all');
      setSelectedProject('all');
    }
  }

  function selectTab(tabId) {
    setActiveTab(tabId);
    if (tabId === 'all' || tabId === 'infra') {
      setSelectedProject('all');
      return;
    }
    setSelectedProject(tabId.replace('project:', ''));
  }

  function togglePin(resource) {
    const key = resourceKey(resource);
    setPinSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleBatch(resource) {
    const key = resourceKey(resource);
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function login() {
    setLoginPending(true);
    setAuthError('');
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser, password: loginPassword }),
      });
      const payload = await parseResponse(response);
      setAuthToken(payload.token || '');
      setActor(payload.user || loginUser);
      setLoginPassword('');
    } catch (errorLogin) {
      setAuthError(errorLogin.message || 'Falha no login.');
    } finally {
      setLoginPending(false);
    }
  }

  async function logout() {
    const token = authToken;
    clearAuthorization();
    await fetch('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }

  const loadRuntimeLogs = useCallback(
    async (applicationUuid) => {
      setIsLoadingRuntimeLogs(true);
      try {
        const payload = await apiFetch(`/api/logs/applications/${applicationUuid}/runtime`);
        setRuntimeLogs(payload.logs || '');
      } catch (fetchError) {
        setRuntimeLogs(`Erro ao carregar logs do container: ${fetchError.message || 'desconhecido'}`);
      } finally {
        setIsLoadingRuntimeLogs(false);
      }
    },
    [apiFetch]
  );

  const loadLatestApplicationLogs = useCallback(
    async (applicationUuid) => {
      setIsLoadingApplicationLogs(true);
      try {
        const payload = await apiFetch(`/api/logs/applications/${applicationUuid}/latest`);
        const logsText = payload.logs || '';
        setApplicationLogs(logsText);
        setApplicationContainerLogs(groupLogsByContainer(logsText));
        setApplicationLogMeta(payload.deployment || null);
      } catch (fetchError) {
        setApplicationLogs(`Erro ao carregar logs: ${fetchError.message || 'desconhecido'}`);
        setApplicationContainerLogs([]);
        setApplicationLogMeta(null);
      } finally {
        setIsLoadingApplicationLogs(false);
      }
    },
    [apiFetch]
  );

  const loadApplicationLogHistory = useCallback(
    async (applicationUuid) => {
      setIsLoadingApplicationLogHistory(true);
      try {
        const payload = await apiFetch(`/api/logs/applications/${applicationUuid}/history?take=5`);
        setApplicationLogHistory(Array.isArray(payload.entries) ? payload.entries : []);
      } catch {
        setApplicationLogHistory([]);
      } finally {
        setIsLoadingApplicationLogHistory(false);
      }
    },
    [apiFetch]
  );

  const loadCompareApplicationLogs = useCallback(
    async (resource) => {
      const key = resourceKey(resource);
      setCompareLogState((prev) => ({
        ...prev,
        [key]: {
          logs: prev[key]?.logs || '',
          deployment: prev[key]?.deployment || null,
          loading: true,
          error: '',
        },
      }));

      try {
        const payload = await apiFetch(`/api/logs/applications/${resource.uuid}/latest`);
        setCompareLogState((prev) => ({
          ...prev,
          [key]: {
            logs: payload.logs || '',
            deployment: payload.deployment || null,
            loading: false,
            error: '',
          },
        }));
      } catch (fetchError) {
        setCompareLogState((prev) => ({
          ...prev,
          [key]: {
            logs: '',
            deployment: null,
            loading: false,
            error: fetchError.message || 'Erro ao carregar logs.',
          },
        }));
      }
    },
    [apiFetch]
  );

  function toggleCompare(resource) {
    const key = resourceKey(resource);

    setCompareSlots((prev) => {
      const existsIndex = prev.findIndex((item) => item && resourceKey(item) === key);
      if (existsIndex !== -1) {
        const next = [...prev];
        next[existsIndex] = null;
        return next;
      }

      const firstEmpty = prev.findIndex((item) => !item);
      if (firstEmpty !== -1) {
        const next = [...prev];
        next[firstEmpty] = resource;
        return next;
      }

      return [prev[1], resource];
    });

    setCompareMode(true);
  }

  function clearCompare() {
    setCompareSlots([null, null]);
    setCompareLogState({});
  }

  async function performAction(resource, action) {
    const actionKey = `${action}:${resource.type}:${resource.uuid}`;
    setPendingAction(actionKey);

    try {
      const payload = await apiFetch(
        `/api/actions/${resource.type}/${resource.uuid}/${action}`,
        { method: 'POST' }
      );

      pushEvent(
        'info',
        `[${resource.project || '-'} / ${resource.environment || '-'} / ${resource.name}] ${
          payload.message || `${action} solicitado`
        }`
      );

      await refresh().catch(() => undefined);
      await fetchAudit();

      if (resource.type === 'application' && selectedResource?.uuid === resource.uuid) {
        await loadLatestApplicationLogs(resource.uuid);
        await loadApplicationLogHistory(resource.uuid);
      }

      const inCompare = compareSlots.some(
        (item) => item && item.uuid === resource.uuid && item.type === resource.type
      );
      if (resource.type === 'application' && inCompare) {
        await loadCompareApplicationLogs(resource);
      }
    } catch (actionError) {
      pushEvent('error', `[${resource.name}] ${actionError.message || 'Erro de acao.'}`);
    } finally {
      setPendingAction('');
    }
  }

  /**
   * State-changing actions always go through an explicit confirmation that
   * names the resource. Stopping the wrong production database because two
   * buttons sit next to each other is not an acceptable failure mode.
   */
  function triggerAction(resource, action) {
    if (!DESTRUCTIVE_ACTIONS.has(action)) {
      performAction(resource, action);
      return;
    }

    setConfirmation({
      title: `Confirmar ${action}`,
      body: [
        `${prettyType(resource.type)}: ${resource.name}`,
        `Projeto: ${resource.project || '-'} | Ambiente: ${resource.environment || '-'}`,
        `Status atual: ${resource.status || 'desconhecido'}`,
      ],
      warning:
        action === 'deploy'
          ? 'Um novo deploy sera iniciado imediatamente.'
          : 'O recurso ficara indisponivel durante a operacao.',
      confirmLabel: action,
      onConfirm: () => performAction(resource, action),
    });
  }

  async function performBatch(items, skippedCount) {
    if (skippedCount > 0) {
      pushEvent(
        'error',
        `${skippedCount} recurso(s) foram ignorados no lote por nao suportarem "${batchAction}".`
      );
    }

    setBatchPending(true);
    try {
      const payload = await apiFetch('/api/actions/batch', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      const failed = payload.summary?.failed || 0;
      pushEvent(
        failed ? 'error' : 'info',
        `Lote concluido: ${payload.summary?.succeeded || 0} sucesso, ${failed} falha.`
      );
      setBatchSelected(new Set());
      await refresh().catch(() => undefined);
      await fetchAudit();
    } catch (batchError) {
      pushEvent('error', `[BATCH] ${batchError.message || 'Falha no lote.'}`);
    } finally {
      setBatchPending(false);
    }
  }

  function runBatch() {
    const selectedResources = Array.from(batchSelected)
      .map((key) => resourcesByKey.get(key))
      .filter(Boolean);

    const supported = selectedResources.filter((resource) =>
      canExecuteAction(resource.type, batchAction)
    );
    const skippedCount = selectedResources.length - supported.length;

    if (supported.length === 0) {
      pushEvent(
        'error',
        `Nenhum recurso selecionado suporta a acao em lote "${batchAction}".`
      );
      return;
    }

    const items = supported.map((resource) => ({
      resourceType: resource.type,
      uuid: resource.uuid,
      action: batchAction,
    }));

    if (!DESTRUCTIVE_ACTIONS.has(batchAction)) {
      performBatch(items, skippedCount);
      return;
    }

    setConfirmation({
      title: `Confirmar lote: ${batchAction}`,
      body: [
        `${supported.length} recurso(s) serao afetados:`,
        ...supported
          .slice(0, 12)
          .map((item) => `  - ${prettyType(item.type)} ${item.name} (${item.project || '-'})`),
        ...(supported.length > 12 ? [`  ... e mais ${supported.length - 12}`] : []),
      ],
      warning: `Esta acao atinge varios recursos ao mesmo tempo e nao pode ser desfeita automaticamente.`,
      confirmLabel: `Executar em ${supported.length}`,
      requireTypedText: supported.length > 3 ? String(supported.length) : '',
      onConfirm: () => performBatch(items, skippedCount),
    });
  }

  useEffect(() => {
    if (!selectedResource || selectedResource.type !== 'application' || !isAuthorized) {
      return undefined;
    }

    const uuid = selectedResource.uuid;
    loadRuntimeLogs(uuid);
    loadLatestApplicationLogs(uuid);
    loadApplicationLogHistory(uuid);

    const timer = setInterval(() => {
      if (document.hidden) return;
      if (logTab === 'runtime') {
        loadRuntimeLogs(uuid);
      } else {
        loadLatestApplicationLogs(uuid);
      }
    }, LOG_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [
    selectedResource?.uuid,
    selectedResource?.type,
    isAuthorized,
    logTab,
    loadRuntimeLogs,
    loadLatestApplicationLogs,
    loadApplicationLogHistory,
  ]);

  useEffect(() => {
    if (!isAuthorized || !compareMode) {
      return undefined;
    }

    const applicationTargets = compareSlots.filter(
      (item) => item && item.type === 'application'
    );

    if (applicationTargets.length === 0) {
      return undefined;
    }

    applicationTargets.forEach((target) => loadCompareApplicationLogs(target));

    const timer = setInterval(() => {
      if (document.hidden) return;
      applicationTargets.forEach((target) => loadCompareApplicationLogs(target));
    }, LOG_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [compareSlots, compareMode, isAuthorized, loadCompareApplicationLogs]);

  if (!authResolved) {
    return <div className="auth-screen">Inicializando painel...</div>;
  }

  if (!isAuthorized) {
    return (
      <div className="auth-screen">
        <form
          className="auth-card"
          onSubmit={(event) => {
            event.preventDefault();
            login();
          }}
        >
          <h2>Acesso ao Control Center</h2>
          <p>Informe suas credenciais para operar os recursos.</p>
          <input
            value={loginUser}
            onChange={(event) => setLoginUser(event.target.value)}
            placeholder="Usuario"
            autoComplete="username"
          />
          <input
            type="password"
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            placeholder="Senha"
            autoComplete="current-password"
          />
          <button className="btn deploy" type="submit" disabled={loginPending}>
            {loginPending ? 'Entrando...' : 'Entrar'}
          </button>
          {authError && <div className="error-box">{authError}</div>}
        </form>
      </div>
    );
  }

  const isStale = Boolean(error) && Boolean(lastSuccessAt);

  return (
    <div className="layout-root">
      {confirmation && (
        <ConfirmDialog
          confirmation={confirmation}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const action = confirmation.onConfirm;
            setConfirmation(null);
            action();
          }}
        />
      )}

      <header className="topbar">
        <div>
          <h1>Control Center</h1>
          <p>Operacao multi-projetos em uma unica pagina</p>
        </div>
        <div className="toolbar">
          <input
            className="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar recurso, projeto, ambiente..."
          />
          <button className="btn secondary" onClick={() => refresh().catch(() => undefined)}>
            Atualizar
          </button>
          <button
            className={`btn ${compareMode ? 'deploy' : ''}`}
            onClick={() => setCompareMode((prev) => !prev)}
          >
            {compareMode ? 'Sair do Compare' : 'Compare Mode'}
          </button>
          <span className="actor-badge" title="Usuario da sessao (usado na auditoria)">
            {actor || 'sessao'}
          </span>
          <button className="btn secondary" onClick={logout}>
            Sair
          </button>
        </div>
      </header>

      {isStale && (
        <div className="stale-banner">
          Exibindo dados de {formatClock(lastSuccessAt)} — atualizacao falhando: {error}
        </div>
      )}

      <div className="tabs-row">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => selectTab(tab.id)}
          >
            <span>{tab.label}</span>
            {tab.id !== 'all' && tab.id !== 'infra' && (
              <span
                className="tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                x
              </span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'infra' ? (
        <main className="content-grid infra">
          <section className="panel center-panel wide">
            <div className="panel-title">Infraestrutura (VPS)</div>
            <VpsPanel apiFetch={apiFetch} pushEvent={pushEvent} />
          </section>
        </main>
      ) : (
      <main className="content-grid">
        <aside className="panel projects-panel">
          <div className="panel-title">Projetos</div>
          <button
            className={`project-item ${selectedProject === 'all' ? 'selected' : ''}`}
            onClick={() => {
              setSelectedProject('all');
              setActiveTab('all');
            }}
          >
            Todos os projetos
          </button>
          {projects.map((project) => (
            <div key={project.uuid} className="project-line">
              <button
                className={`project-item ${selectedProject === project.name ? 'selected' : ''}`}
                onClick={() => addTab(project.name)}
              >
                {project.name}
              </button>
            </div>
          ))}
        </aside>

        <section className="panel center-panel">
          <div className="summary-row">
            {STATUS_BUCKETS.map((bucket) => (
              <StatCard
                key={bucket}
                label={STATUS_LABELS[bucket]}
                value={summary[bucket]}
                tone={bucket}
              />
            ))}
            <StatCard label="Total" value={summary.total} tone="total" />
          </div>

          {attentionCount > 0 && (
            <div className="attention-banner">
              {attentionCount} recurso(s) precisam de atencao (erro ou degradado).
            </div>
          )}

          <div className="batch-toolbar">
            <span>{batchSelected.size} selecionados para lote</span>
            <select
              className="batch-select"
              value={batchAction}
              onChange={(event) => setBatchAction(event.target.value)}
            >
              <option value="start">start</option>
              <option value="stop">stop</option>
              <option value="restart">restart</option>
              <option value="deploy">deploy</option>
            </select>
            <button
              className="btn deploy"
              disabled={batchPending || batchSelected.size === 0}
              onClick={runBatch}
            >
              {batchPending ? 'Executando lote...' : 'Executar lote'}
            </button>
          </div>

          {compareMode && (
            <div className="compare-toolbar">
              <span>
                Compare slots: {compareSlots[0] ? '1' : '-'} | {compareSlots[1] ? '2' : '-'}
              </span>
              <button className="btn" onClick={clearCompare}>Limpar compare</button>
            </div>
          )}

          {error && !isStale && <div className="error-box">{error}</div>}
          {loading && <div className="empty-box">Carregando dados...</div>}

          {!loading && pinnedResources.length > 0 && (
            <>
              <div className="section-title">Fixados</div>
              <div className="resource-grid">
                {pinnedResources.map((resource) => (
                  <ResourceCard
                    key={resourceKey(resource)}
                    resource={resource}
                    pinned
                    checked={batchSelected.has(resourceKey(resource))}
                    inCompare={compareSet.has(resourceKey(resource))}
                    pendingAction={pendingAction}
                    onTogglePin={togglePin}
                    onToggleBatch={toggleBatch}
                    onAction={triggerAction}
                    onSelect={setSelectedResource}
                    onCompare={toggleCompare}
                    isSelected={
                      selectedResource?.uuid === resource.uuid &&
                      selectedResource?.type === resource.type
                    }
                  />
                ))}
              </div>
            </>
          )}

          <div className="section-title">Recursos</div>
          <div className="resource-grid">
            {scopedResources.map((resource) => (
              <ResourceCard
                key={resourceKey(resource)}
                resource={resource}
                pinned={pinSet.has(resourceKey(resource))}
                checked={batchSelected.has(resourceKey(resource))}
                inCompare={compareSet.has(resourceKey(resource))}
                pendingAction={pendingAction}
                onTogglePin={togglePin}
                onToggleBatch={toggleBatch}
                onAction={triggerAction}
                onSelect={setSelectedResource}
                onCompare={toggleCompare}
                isSelected={
                  selectedResource?.uuid === resource.uuid &&
                  selectedResource?.type === resource.type
                }
              />
            ))}
          </div>

          {!loading && scopedResources.length === 0 && (
            <div className="empty-box">Nenhum recurso encontrado com os filtros atuais.</div>
          )}
        </section>

        <aside className="panel logs-panel">
          {compareMode ? (
            <ComparePanel
              compareSlots={compareSlots}
              compareLogState={compareLogState}
              onRefreshLogs={loadCompareApplicationLogs}
            />
          ) : (
            <InspectorPanel
              selectedResource={selectedResource}
              events={events}
              auditEntries={auditEntries}
              auditLoading={auditLoading}
              logTab={logTab}
              onChangeLogTab={setLogTab}
              runtimeLogs={runtimeLogs}
              isLoadingRuntimeLogs={isLoadingRuntimeLogs}
              applicationLogs={applicationLogs}
              applicationLogMeta={applicationLogMeta}
              applicationContainerLogs={applicationContainerLogs}
              isLoadingApplicationLogs={isLoadingApplicationLogs}
              applicationLogHistory={applicationLogHistory}
              isLoadingApplicationLogHistory={isLoadingApplicationLogHistory}
              onRefreshRuntimeLogs={loadRuntimeLogs}
              onRefreshLogs={loadLatestApplicationLogs}
              onRefreshLogHistory={loadApplicationLogHistory}
              onRefreshAudit={fetchAudit}
            />
          )}
        </aside>
      </main>
      )}
    </div>
  );
}

function ConfirmDialog({ confirmation, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const required = confirmation.requireTypedText || '';
  const canConfirm = !required || typed.trim() === required;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>{confirmation.title}</h3>
        <div className="modal-body">
          {confirmation.body.map((line, index) => (
            <div key={index} className="modal-line">{line}</div>
          ))}
        </div>
        {confirmation.warning && <div className="modal-warning">{confirmation.warning}</div>}
        {required && (
          <label className="modal-confirm-input">
            <span>Digite <strong>{required}</strong> para confirmar:</span>
            <input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
          </label>
        )}
        <div className="modal-actions">
          <button className="btn secondary" onClick={onCancel}>Cancelar</button>
          <button className="btn danger" disabled={!canConfirm} onClick={onConfirm}>
            {confirmation.confirmLabel || 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function InspectorPanel({
  selectedResource,
  events,
  auditEntries,
  auditLoading,
  logTab,
  onChangeLogTab,
  runtimeLogs,
  isLoadingRuntimeLogs,
  applicationLogs,
  applicationLogMeta,
  applicationContainerLogs,
  isLoadingApplicationLogs,
  applicationLogHistory,
  isLoadingApplicationLogHistory,
  onRefreshRuntimeLogs,
  onRefreshLogs,
  onRefreshLogHistory,
  onRefreshAudit,
}) {
  return (
    <>
      <div className="panel-title">Inspector</div>
      {selectedResource ? (
        <div className="inspector-head">
          <div className="resource-title">{selectedResource.name}</div>
          <div className="resource-meta">
            {prettyType(selectedResource.type)} | {selectedResource.project || '-'} |{' '}
            {selectedResource.environment || '-'}
          </div>
        </div>
      ) : (
        <div className="empty-box small">Selecione um recurso para inspecionar.</div>
      )}

      <div className="inspector-block">
        <div className="inspector-block-title">Console de Operacoes</div>
        <div className="logs-list event-list">
          {events.map((line) => (
            <div key={line.id} className={`log-line ${line.level}`}>
              <div className="log-time">{formatClock(line.timestamp)}</div>
              <div>{line.message}</div>
            </div>
          ))}
          {events.length === 0 && (
            <div className="empty-box small">
              Sem eventos ainda. Execute Start/Stop/Restart/Deploy para alimentar o painel.
            </div>
          )}
        </div>
      </div>

      <div className="inspector-block">
        <div className="inspector-block-title row">
          <span>Auditoria persistente</span>
          <button className="btn" onClick={onRefreshAudit} disabled={auditLoading}>
            {auditLoading ? 'Atualizando...' : 'Atualizar'}
          </button>
        </div>
        <div className="logs-list event-list">
          {auditEntries.slice(0, 30).map((entry, idx) => (
            <div key={`${entry.timestamp || idx}-${idx}`} className="log-line info">
              <div className="log-time">
                {entry.timestamp ? new Date(entry.timestamp).toLocaleString('pt-BR') : 'sem horario'}
              </div>
              <div>
                [{entry.actor || 'unknown'}] {entry.type || 'evento'} - {entry.status || 'n/a'}
              </div>
            </div>
          ))}
          {auditEntries.length === 0 && (
            <div className="empty-box small">Sem eventos de auditoria ainda.</div>
          )}
        </div>
      </div>

      {selectedResource?.type === 'application' && (
        <div className="inspector-block">
          <div className="log-tabs">
            <button
              className={`log-tab ${logTab === 'runtime' ? 'active' : ''}`}
              onClick={() => onChangeLogTab('runtime')}
            >
              Container (ao vivo)
            </button>
            <button
              className={`log-tab ${logTab === 'deploy' ? 'active' : ''}`}
              onClick={() => onChangeLogTab('deploy')}
            >
              Ultimo deploy
            </button>
          </div>

          {logTab === 'runtime' ? (
            <>
              <div className="inspector-block-title row">
                <span>Logs do container em execucao</span>
                <button
                  className="btn"
                  onClick={() => onRefreshRuntimeLogs(selectedResource.uuid)}
                  disabled={isLoadingRuntimeLogs}
                >
                  {isLoadingRuntimeLogs ? 'Atualizando...' : 'Atualizar'}
                </button>
              </div>
              <pre className="log-preview">
                {runtimeLogs || 'Nenhum log de runtime retornado para esta aplicacao.'}
              </pre>
            </>
          ) : (
            <>
              <div className="inspector-block-title row">
                <span>Logs do ultimo deployment</span>
                <div className="inline-actions">
                  <button
                    className="btn"
                    onClick={() => onRefreshLogs(selectedResource.uuid)}
                    disabled={isLoadingApplicationLogs}
                  >
                    {isLoadingApplicationLogs ? 'Atualizando...' : 'Atualizar ultimo'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => onRefreshLogHistory(selectedResource.uuid)}
                    disabled={isLoadingApplicationLogHistory}
                  >
                    {isLoadingApplicationLogHistory ? 'Atualizando...' : 'Atualizar historico'}
                  </button>
                </div>
              </div>
              {applicationLogMeta && (
                <div className="log-meta">
                  Status: {applicationLogMeta.status || 'unknown'}
                  {' | '}
                  {applicationLogMeta.created_at
                    ? new Date(applicationLogMeta.created_at).toLocaleString('pt-BR')
                    : 'sem data'}
                </div>
              )}
              <pre className="log-preview">
                {applicationLogs || 'Nenhum log retornado para a ultima execucao.'}
              </pre>

              <div className="section-title">Logs por container (extraido)</div>
              <div className="history-list">
                {applicationContainerLogs.map((entry) => (
                  <details key={entry.name} className="history-item">
                    <summary>
                      {entry.name} - {entry.lines} linhas
                    </summary>
                    <pre className="log-preview small">{entry.logs || 'Sem logs neste grupo.'}</pre>
                  </details>
                ))}
                {applicationContainerLogs.length === 0 && (
                  <div className="empty-box small">
                    Nao foi possivel segmentar por container neste log; exibindo apenas log bruto.
                  </div>
                )}
              </div>

              <div className="section-title">Historico (ultimos 5 deploys)</div>
              <div className="history-list">
                {applicationLogHistory.map((entry, index) => (
                  <details key={`${entry.deployment?.id || index}-${index}`} className="history-item">
                    <summary>
                      {(entry.deployment?.status || 'unknown').toUpperCase()} -{' '}
                      {entry.deployment?.created_at
                        ? new Date(entry.deployment.created_at).toLocaleString('pt-BR')
                        : 'sem data'}
                    </summary>
                    <pre className="log-preview small">
                      {entry.logs || 'Sem logs para este deployment.'}
                    </pre>
                  </details>
                ))}
                {!isLoadingApplicationLogHistory && applicationLogHistory.length === 0 && (
                  <div className="empty-box small">Sem historico de logs para esta aplicacao.</div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {selectedResource && selectedResource.type !== 'application' && (
        <div className="empty-box small">
          Visualizacao de logs detalhados nesta fase esta habilitada para aplicacoes.
        </div>
      )}
    </>
  );
}

function ComparePanel({ compareSlots, compareLogState, onRefreshLogs }) {
  return (
    <>
      <div className="panel-title">Compare Mode</div>
      <div className="compare-grid">
        {compareSlots.map((resource, index) => (
          <div key={`slot-${index}`} className="compare-slot">
            <div className="compare-slot-title">Slot {index + 1}</div>
            {!resource && (
              <div className="empty-box small">Selecione um recurso e clique em Compare.</div>
            )}
            {resource && (
              <>
                <div className="inspector-head compact">
                  <div className="resource-title">{resource.name}</div>
                  <div className="resource-meta">
                    {prettyType(resource.type)} | {resource.project || '-'} |{' '}
                    {resource.environment || '-'}
                  </div>
                </div>
                {resource.type === 'application' ? (
                  <CompareApplicationLogs
                    resource={resource}
                    state={compareLogState[resourceKey(resource)]}
                    onRefreshLogs={onRefreshLogs}
                  />
                ) : (
                  <div className="empty-box small">
                    Compare detalhado de logs disponivel para aplicacoes.
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function CompareApplicationLogs({ resource, state, onRefreshLogs }) {
  const loading = Boolean(state?.loading);
  const error = state?.error || '';
  const logs = state?.logs || '';
  const deployment = state?.deployment || null;

  return (
    <div className="inspector-block">
      <div className="inspector-block-title row">
        <span>Logs recentes</span>
        <button className="btn" onClick={() => onRefreshLogs(resource)} disabled={loading}>
          {loading ? 'Atualizando...' : 'Atualizar'}
        </button>
      </div>
      {deployment && (
        <div className="log-meta">
          Status: {deployment.status || 'unknown'}
          {' | '}
          {deployment.created_at
            ? new Date(deployment.created_at).toLocaleString('pt-BR')
            : 'sem data'}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      <pre className="log-preview">{logs || 'Nenhum log retornado para a ultima execucao.'}</pre>
    </div>
  );
}

function ResourceCard({
  resource,
  pinned,
  checked,
  inCompare,
  pendingAction,
  onTogglePin,
  onToggleBatch,
  onAction,
  onSelect,
  onCompare,
  isSelected,
}) {
  const actionBusy = (action) => pendingAction === `${action}:${resource.type}:${resource.uuid}`;
  const needsAttention = ATTENTION_BUCKETS.has(resource.statusBucket);

  return (
    <article
      className={`resource-card ${isSelected ? 'selected' : ''} ${
        needsAttention ? 'attention' : ''
      }`}
    >
      <div className="resource-head">
        <label className="batch-check">
          <input type="checkbox" checked={checked} onChange={() => onToggleBatch(resource)} />
          <span>Lote</span>
        </label>
        <button className={`pin ${pinned ? 'active' : ''}`} onClick={() => onTogglePin(resource)}>
          {pinned ? 'Fixado' : 'Fixar'}
        </button>
      </div>

      <div className="resource-title">{resource.name}</div>
      <div className="resource-meta">
        {prettyType(resource.type)} | {resource.project || '-'} | {resource.environment || '-'}
      </div>

      <div className="resource-status-row">
        <span className={`dot ${resource.statusBucket}`} />
        <span className="status-text">{resource.status || 'unknown'}</span>
        {resource.healthStatus === 'unhealthy' && (
          <span className="health-flag" title="Container no ar, mas falhando o healthcheck">
            healthcheck falhando
          </span>
        )}
      </div>

      <p className="resource-description">{resource.description || 'Sem descricao.'}</p>

      <div className="actions-row">
        <button className="btn" onClick={() => onSelect(resource)}>
          Inspect
        </button>
        <button className={`btn ${inCompare ? 'deploy' : ''}`} onClick={() => onCompare(resource)}>
          {inCompare ? 'No Compare' : 'Compare'}
        </button>
        <button className="btn" disabled={actionBusy('start')} onClick={() => onAction(resource, 'start')}>
          {actionBusy('start') ? 'Iniciando...' : 'Start'}
        </button>
        <button
          className="btn warn"
          disabled={actionBusy('stop')}
          onClick={() => onAction(resource, 'stop')}
        >
          {actionBusy('stop') ? 'Parando...' : 'Stop'}
        </button>
        <button
          className="btn warn"
          disabled={actionBusy('restart')}
          onClick={() => onAction(resource, 'restart')}
        >
          {actionBusy('restart') ? 'Reiniciando...' : 'Restart'}
        </button>
        {resource.type === 'application' && (
          <button
            className="btn deploy"
            disabled={actionBusy('deploy')}
            onClick={() => onAction(resource, 'deploy')}
          >
            {actionBusy('deploy') ? 'Deploy...' : 'Deploy'}
          </button>
        )}
      </div>
    </article>
  );
}
