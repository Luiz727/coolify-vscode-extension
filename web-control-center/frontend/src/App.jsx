import { useEffect, useMemo, useState } from 'react';

const POLL_INTERVAL_MS = 7000;
const STORAGE_KEYS = {
  query: 'cc.query',
  selectedProject: 'cc.selectedProject',
  pinned: 'cc.pinned',
  compareMode: 'cc.compareMode',
  compareSlots: 'cc.compareSlots',
  token: 'cc.auth.token',
  actor: 'cc.auth.actor',
};

const STATUS_ORDER = {
  running: 0,
  starting: 1,
  stopped: 2,
  error: 3,
  unknown: 4,
};

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

function useControlCenterData({ authToken, actor, onUnauthorized }) {
  const [projects, setProjects] = useState([]);
  const [resources, setResources] = useState({
    applications: [],
    services: [],
    databases: [],
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function apiFetch(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (authToken && authToken !== 'no-auth') {
      headers.Authorization = `Bearer ${authToken}`;
    }
    if (actor) {
      headers['x-actor'] = actor;
    }

    try {
      const response = await fetch(path, {
        ...options,
        headers,
      });

      if (response.status === 401) {
        onUnauthorized();
      }

      return await parseResponse(response);
    } catch (fetchError) {
      throw fetchError;
    }
  }

  async function refresh() {
    try {
      setError('');
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
    } catch (fetchError) {
      setError(fetchError.message || 'Erro ao carregar dados.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authToken, actor]);

  return { projects, resources, loading, error, refresh, apiFetch };
}

export default function App() {
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);
  const [authToken, setAuthToken] = useState(() => readStorage(STORAGE_KEYS.token, ''));
  const [actor, setActor] = useState(() => readStorage(STORAGE_KEYS.actor, 'operator-web'));
  const [loginUser, setLoginUser] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [loginPending, setLoginPending] = useState(false);

  const [query, setQuery] = useState(() => readStorage(STORAGE_KEYS.query, ''));
  const [selectedProject, setSelectedProject] = useState(() =>
    readStorage(STORAGE_KEYS.selectedProject, 'all') || 'all'
  );
  const [tabs, setTabs] = useState([{ id: 'all', label: 'Visao Geral' }]);
  const [activeTab, setActiveTab] = useState('all');
  const [events, setEvents] = useState([]);
  const [pendingAction, setPendingAction] = useState('');
  const [pinSet, setPinSet] = useState(() => new Set(readStorage(STORAGE_KEYS.pinned, [])));
  const [batchSelected, setBatchSelected] = useState(new Set());
  const [batchAction, setBatchAction] = useState('restart');
  const [batchPending, setBatchPending] = useState(false);

  const [selectedResource, setSelectedResource] = useState(null);
  const [applicationLogs, setApplicationLogs] = useState('');
  const [applicationLogMeta, setApplicationLogMeta] = useState(null);
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

  const isAuthorized = !authEnabled || Boolean(authToken);

  function clearAuthorization() {
    setAuthToken('');
    writeStorage(STORAGE_KEYS.token, '');
  }

  const { projects, resources, loading, error, refresh, apiFetch } = useControlCenterData({
    authToken,
    actor,
    onUnauthorized: clearAuthorization,
  });

  const allResources = useMemo(
    () => [...resources.applications, ...resources.services, ...resources.databases],
    [resources]
  );

  const resourcesByKey = useMemo(() => {
    return new Map(allResources.map((item) => [resourceKey(item), item]));
  }, [allResources]);

  const scopedResources = useMemo(() => {
    let items = allResources;
    if (selectedProject !== 'all') {
      items = items.filter((item) => item.project === selectedProject);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      items = items.filter((item) => {
        return (
          item.name?.toLowerCase().includes(q) ||
          item.description?.toLowerCase().includes(q) ||
          item.environment?.toLowerCase().includes(q) ||
          item.project?.toLowerCase().includes(q)
        );
      });
    }

    return [...items].sort((a, b) => {
      const statusDelta = STATUS_ORDER[a.statusBucket] - STATUS_ORDER[b.statusBucket];
      if (statusDelta !== 0) return statusDelta;
      return String(a.name).localeCompare(String(b.name));
    });
  }, [allResources, selectedProject, query]);

  const summary = useMemo(() => {
    return scopedResources.reduce(
      (acc, item) => {
        const key = item.statusBucket || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      { running: 0, starting: 0, stopped: 0, error: 0, unknown: 0 }
    );
  }, [scopedResources]);

  const pinnedResources = scopedResources.filter((item) => pinSet.has(resourceKey(item)));

  const compareSet = useMemo(() => {
    const keys = compareSlots.filter(Boolean).map((item) => resourceKey(item));
    return new Set(keys);
  }, [compareSlots]);

  useEffect(() => {
    async function bootstrapAuth() {
      try {
        const response = await fetch('/auth/status');
        const payload = await parseResponse(response);
        setAuthEnabled(Boolean(payload.authEnabled));
      } catch {
        setAuthEnabled(false);
      } finally {
        setAuthResolved(true);
      }
    }

    bootstrapAuth();
  }, []);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.query, query);
  }, [query]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.selectedProject, selectedProject);
  }, [selectedProject]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.compareMode, compareMode);
  }, [compareMode]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.pinned, Array.from(pinSet));
  }, [pinSet]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.token, authToken || '');
  }, [authToken]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.actor, actor || 'operator-web');
  }, [actor]);

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

      return prev.map((item) => {
        if (!item) return null;
        return resourcesByKey.get(resourceKey(item)) || null;
      });
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

  useEffect(() => {
    if (!isAuthorized) {
      return;
    }

    fetchAudit();
    const timer = setInterval(fetchAudit, 12000);
    return () => clearInterval(timer);
  }, [isAuthorized, authToken]);

  function addTab(projectName) {
    const tabId = `project:${projectName}`;
    if (!tabs.some((tab) => tab.id === tabId)) {
      setTabs((prev) => [...prev, { id: tabId, label: projectName }]);
    }
    setActiveTab(tabId);
    setSelectedProject(projectName);
  }

  function closeTab(tabId) {
    if (tabId === 'all') return;
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    if (activeTab === tabId) {
      setActiveTab('all');
      setSelectedProject('all');
    }
  }

  function selectTab(tabId) {
    setActiveTab(tabId);
    if (tabId === 'all') {
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
      setActor(loginUser || actor || 'operator-web');
      setLoginPassword('');
      // refresh/fetchAudit serao acionados automaticamente quando authToken mudar.
    } catch (errorLogin) {
      setAuthError(errorLogin.message || 'Falha no login.');
    } finally {
      setLoginPending(false);
    }
  }

  async function fetchAudit() {
    setAuditLoading(true);
    try {
      const payload = await apiFetch('/api/audit?take=120');
      setAuditEntries(payload.entries || []);
    } catch (auditError) {
      setEvents((prev) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          level: 'error',
          message: `[AUDIT] ${auditError.message || 'Falha ao carregar auditoria.'}`,
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ]);
    } finally {
      setAuditLoading(false);
    }
  }

  async function loadLatestApplicationLogs(applicationUuid) {
    setIsLoadingApplicationLogs(true);
    try {
      const payload = await apiFetch(`/api/logs/applications/${applicationUuid}/latest`);
      setApplicationLogs(payload.logs || '');
      setApplicationLogMeta(payload.deployment || null);
    } catch (fetchError) {
      setApplicationLogs(`Erro ao carregar logs: ${fetchError.message || 'desconhecido'}`);
      setApplicationLogMeta(null);
    } finally {
      setIsLoadingApplicationLogs(false);
    }
  }

  async function loadApplicationLogHistory(applicationUuid) {
    setIsLoadingApplicationLogHistory(true);
    try {
      const payload = await apiFetch(`/api/logs/applications/${applicationUuid}/history?take=5`);
      setApplicationLogHistory(Array.isArray(payload.entries) ? payload.entries : []);
    } catch {
      setApplicationLogHistory([]);
    } finally {
      setIsLoadingApplicationLogHistory(false);
    }
  }

  async function loadCompareApplicationLogs(resource) {
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
  }

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

  async function triggerAction(resource, action) {
    const actionKey = `${action}:${resource.type}:${resource.uuid}`;
    setPendingAction(actionKey);

    try {
      const payload = await apiFetch(
        `/api/actions/${resource.type}/${resource.uuid}/${action}`,
        { method: 'POST' }
      );

      setEvents((prev) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          level: 'info',
          message: `[${resource.project || '-'} / ${resource.environment || '-'} / ${resource.name}] ${payload.message || `${action} solicitado`}`,
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ]);

      await refresh();
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
      setEvents((prev) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          level: 'error',
          message: `[${resource.name}] ${actionError.message || 'Erro de acao.'}`,
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ]);
    } finally {
      setPendingAction('');
    }
  }

  async function runBatch() {
    const items = Array.from(batchSelected)
      .map((key) => resourcesByKey.get(key))
      .filter(Boolean)
      .map((resource) => ({
        resourceType: resource.type,
        uuid: resource.uuid,
        action: batchAction,
      }));

    if (items.length === 0) {
      return;
    }

    setBatchPending(true);
    try {
      const payload = await apiFetch('/api/actions/batch', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      const summaryText = `Lote concluido: ${payload.summary?.succeeded || 0} sucesso, ${payload.summary?.failed || 0} falha.`;
      setEvents((prev) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          level: payload.summary?.failed ? 'error' : 'info',
          message: summaryText,
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ]);
      setBatchSelected(new Set());
      await refresh();
      await fetchAudit();
    } catch (batchError) {
      setEvents((prev) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          level: 'error',
          message: `[BATCH] ${batchError.message || 'Falha no lote.'}`,
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ]);
    } finally {
      setBatchPending(false);
    }
  }

  useEffect(() => {
    if (!selectedResource || selectedResource.type !== 'application' || !isAuthorized) {
      return undefined;
    }

    loadLatestApplicationLogs(selectedResource.uuid);
    loadApplicationLogHistory(selectedResource.uuid);
    const timer = setInterval(() => {
      loadLatestApplicationLogs(selectedResource.uuid);
    }, 12000);

    return () => clearInterval(timer);
  }, [selectedResource?.uuid, selectedResource?.type, isAuthorized]);

  useEffect(() => {
    if (!isAuthorized) {
      return undefined;
    }

    const applicationTargets = compareSlots.filter(
      (item) => item && item.type === 'application'
    );

    if (applicationTargets.length === 0) {
      return undefined;
    }

    applicationTargets.forEach((target) => {
      loadCompareApplicationLogs(target);
    });

    const timer = setInterval(() => {
      applicationTargets.forEach((target) => {
        loadCompareApplicationLogs(target);
      });
    }, 15000);

    return () => clearInterval(timer);
  }, [compareSlots, isAuthorized]);

  if (!authResolved) {
    return <div className="auth-screen">Inicializando painel...</div>;
  }

  if (authEnabled && !isAuthorized) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h2>Acesso ao Control Center</h2>
          <p>Autenticacao web habilitada. Informe suas credenciais.</p>
          <input
            value={loginUser}
            onChange={(event) => setLoginUser(event.target.value)}
            placeholder="Usuario"
          />
          <input
            type="password"
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            placeholder="Senha"
          />
          <button className="btn deploy" onClick={login} disabled={loginPending}>
            {loginPending ? 'Entrando...' : 'Entrar'}
          </button>
          {authError && <div className="error-box">{authError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="layout-root">
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
          <input
            className="actor-input"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            placeholder="Actor auditoria"
          />
          <button className="btn secondary" onClick={refresh}>Atualizar</button>
          <button
            className={`btn ${compareMode ? 'deploy' : ''}`}
            onClick={() => setCompareMode((prev) => !prev)}
          >
            {compareMode ? 'Sair do Compare' : 'Compare Mode'}
          </button>
        </div>
      </header>

      <div className="tabs-row">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => selectTab(tab.id)}
          >
            <span>{tab.label}</span>
            {tab.id !== 'all' && (
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
            <StatCard label="Rodando" value={summary.running} tone="running" />
            <StatCard label="Iniciando" value={summary.starting} tone="starting" />
            <StatCard label="Parados" value={summary.stopped} tone="stopped" />
            <StatCard label="Erro" value={summary.error} tone="error" />
          </div>

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

          {error && <div className="error-box">{error}</div>}
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
                    isSelected={selectedResource?.uuid === resource.uuid && selectedResource?.type === resource.type}
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
                isSelected={selectedResource?.uuid === resource.uuid && selectedResource?.type === resource.type}
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
              applicationLogs={applicationLogs}
              applicationLogMeta={applicationLogMeta}
              isLoadingApplicationLogs={isLoadingApplicationLogs}
              applicationLogHistory={applicationLogHistory}
              isLoadingApplicationLogHistory={isLoadingApplicationLogHistory}
              onRefreshLogs={loadLatestApplicationLogs}
              onRefreshLogHistory={loadApplicationLogHistory}
              onRefreshAudit={fetchAudit}
            />
          )}
        </aside>
      </main>
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
  applicationLogs,
  applicationLogMeta,
  isLoadingApplicationLogs,
  applicationLogHistory,
  isLoadingApplicationLogHistory,
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
            {prettyType(selectedResource.type)} | {selectedResource.project || '-'} | {selectedResource.environment || '-'}
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
              <div className="log-time">{new Date(line.timestamp).toLocaleTimeString('pt-BR')}</div>
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
          <div className="inspector-block-title row">
            <span>Logs recentes (ultimo deployment)</span>
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
                    {prettyType(resource.type)} | {resource.project || '-'} | {resource.environment || '-'}
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
        <button
          className="btn"
          onClick={() => onRefreshLogs(resource)}
          disabled={loading}
        >
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

  return (
    <article className={`resource-card ${isSelected ? 'selected' : ''}`}>
      <div className="resource-head">
        <label className="batch-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onToggleBatch(resource)}
          />
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
      </div>

      <p className="resource-description">{resource.description || 'Sem descricao.'}</p>

      <div className="actions-row">
        <button className="btn" onClick={() => onSelect(resource)}>
          Inspect
        </button>
        <button
          className={`btn ${inCompare ? 'deploy' : ''}`}
          onClick={() => onCompare(resource)}
        >
          {inCompare ? 'No Compare' : 'Compare'}
        </button>
        <button className="btn" disabled={actionBusy('start')} onClick={() => onAction(resource, 'start')}>
          {actionBusy('start') ? 'Iniciando...' : 'Start'}
        </button>
        <button className="btn" disabled={actionBusy('stop')} onClick={() => onAction(resource, 'stop')}>
          {actionBusy('stop') ? 'Parando...' : 'Stop'}
        </button>
        <button className="btn" disabled={actionBusy('restart')} onClick={() => onAction(resource, 'restart')}>
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
