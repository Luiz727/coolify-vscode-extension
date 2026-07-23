import { useCallback, useEffect, useMemo, useState } from 'react';

import { buildSparklinePath } from './chartGeometry.js';

/**
 * Infrastructure panel: the layer Coolify cannot see.
 *
 * Coolify reports container state; this panel reports the machine underneath —
 * CPU, memory, disk and network — and ties each VPS back to the Coolify
 * resources it hosts, so "7 apps are down" becomes "7 apps are down because
 * srv-01 filled its disk".
 */

const WINDOWS = [
  { id: 1, label: '1h' },
  { id: 24, label: '24h' },
  { id: 168, label: '7d' },
];

/** Metrics are small multiples: one single-series chart each, no legend needed. */
const METRICS = [
  { key: 'cpu', label: 'CPU', unit: '%', max: 100, thresholdKey: 'cpuPct' },
  { key: 'ram', label: 'Memoria', unit: '%', max: 100, thresholdKey: 'ramPct' },
  { key: 'disk', label: 'Disco', unit: '%', max: 100, thresholdKey: 'diskPct' },
];

function formatBytes(value) {
  if (value === null || value === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(Number(seconds))) return '—';
  const total = Number(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${Number(value).toFixed(0)}%`;
}

/** Maps a reading to a reserved status role. Never used for series identity. */
function statusRole(value, limit) {
  if (value === null || value === undefined || !limit) return 'normal';
  if (value >= limit) return 'critical';
  if (value >= limit * 0.9) return 'warning';
  return 'normal';
}

/**
 * Single-series time chart.
 *
 * One series per chart means identity never depends on color: the title names
 * the metric. Color is therefore free to carry state (normal / warning /
 * critical), always paired with the printed value and a text label.
 */
function MetricChart({ points, max, unit, role, height = 64 }) {
  const path = useMemo(
    () => buildSparklinePath(points, { max, height }),
    [points, max, height]
  );

  if (!path) {
    return <div className="chart-empty">Sem dados suficientes para o grafico.</div>;
  }

  return (
    <svg
      className={`metric-chart role-${role}`}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Serie temporal em ${unit}`}
    >
      <path className="metric-area" d={path.area} />
      {/* 2px stroke, non-scaling so the aspect stretch never thickens it. */}
      <path className="metric-line" d={path.line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function MetricTile({ metric, series, current, threshold }) {
  const role = statusRole(current, threshold);
  const points = series.map((sample) => ({ t: sample.t, v: sample[metric.key] }));

  return (
    <div className={`metric-tile role-${role}`}>
      <div className="metric-head">
        <span className="metric-label">{metric.label}</span>
        <span className="metric-value">{formatPercent(current)}</span>
      </div>
      <MetricChart points={points} max={metric.max} unit={metric.unit} role={role} />
      <div className="metric-foot">
        {/* Icon + label: a status color never carries meaning on its own. */}
        {role === 'critical' && <span className="metric-flag critical">▲ acima do limite ({threshold}%)</span>}
        {role === 'warning' && <span className="metric-flag warning">▲ proximo do limite ({threshold}%)</span>}
        {role === 'normal' && <span className="metric-flag normal">dentro do limite</span>}
      </div>
    </div>
  );
}

function ConfirmVpsDialog({ request, onCancel, onConfirm }) {
  const [hostname, setHostname] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const hostnameMatches = hostname.trim() === request.vm.hostname;
  const canConfirm = hostnameMatches && (!request.irreversible || acknowledged);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>{request.title}</h3>

        <div className="modal-body">
          <div className="modal-line">Maquina: {request.vm.hostname}</div>
          <div className="modal-line">IP: {request.vm.ipv4 || '—'}</div>
        </div>

        {/* Blast radius: a VPS operation is not a container restart. */}
        <div className="blast-radius">
          <strong>Impacto no Coolify</strong>
          {request.blastRadius ? (
            request.blastRadius.totalResources > 0 ? (
              <>
                <div>
                  {request.blastRadius.totalResources} recurso(s) hospedado(s) nesta
                  maquina serao afetados:
                </div>
                <ul>
                  {request.blastRadius.servers.flatMap((server) =>
                    server.resources.slice(0, 15).map((resource) => (
                      <li key={`${server.serverUuid}-${resource.uuid}`}>
                        {resource.type}: {resource.name}
                      </li>
                    ))
                  )}
                </ul>
              </>
            ) : (
              <div>
                Nenhum recurso do Coolify foi correlacionado a esta maquina. Confirme
                que esta e a maquina certa antes de prosseguir.
              </div>
            )
          ) : (
            <div>Calculando impacto...</div>
          )}
        </div>

        {request.irreversible && (
          <div className="modal-warning irreversible">
            <strong>Operacao irreversivel.</strong> A maquina volta ao estado do ponto
            de restauracao{request.pointLabel ? ` de ${request.pointLabel}` : ''}. Tudo
            que foi gravado depois disso — dados, deploys, uploads — sera perdido e
            nao pode ser recuperado.
          </div>
        )}

        <label className="modal-confirm-input">
          <span>
            Digite <strong>{request.vm.hostname}</strong> para confirmar:
          </span>
          <input
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            autoFocus
            autoComplete="off"
          />
        </label>

        {request.irreversible && (
          <label className="modal-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>Entendo que os dados gravados apos o ponto de restauracao serao perdidos.</span>
          </label>
        )}

        <div className="modal-actions">
          <button className="btn secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="btn danger"
            disabled={!canConfirm}
            onClick={() => onConfirm(hostname.trim(), acknowledged)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function VpsPanel({ apiFetch, pushEvent }) {
  const [state, setState] = useState({ machines: [], thresholds: {}, loading: true });
  const [error, setError] = useState('');
  const [windowHours, setWindowHours] = useState(24);
  const [seriesByVm, setSeriesByVm] = useState({});
  const [restorePoints, setRestorePoints] = useState({});
  const [confirmRequest, setConfirmRequest] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const payload = await apiFetch('/api/vps');
      setState({
        machines: payload.machines || [],
        thresholds: payload.thresholds || {},
        lastCollectedAt: payload.lastCollectedAt,
        historyEnabled: payload.historyEnabled,
        loading: false,
      });
      setError(payload.error || '');
    } catch (fetchError) {
      setState((prev) => ({ ...prev, loading: false }));
      setError(fetchError.message || 'Falha ao carregar dados de VPS.');
    }
  }, [apiFetch]);

  const loadSeries = useCallback(
    async (vmId) => {
      try {
        const payload = await apiFetch(`/api/vps/${vmId}/metrics?hours=${windowHours}`);
        setSeriesByVm((prev) => ({ ...prev, [vmId]: payload.series || [] }));
      } catch {
        setSeriesByVm((prev) => ({ ...prev, [vmId]: [] }));
      }
    },
    [apiFetch, windowHours]
  );

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 60000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    state.machines.forEach((vm) => loadSeries(vm.id));
    // Reloading on window change is intentional; the series length differs.
  }, [state.machines, loadSeries]);

  async function openConfirmation({ vm, title, confirmLabel, irreversible, pointLabel, perform }) {
    setConfirmRequest({ vm, title, confirmLabel, irreversible, pointLabel, perform, blastRadius: null });

    const blastRadius = await apiFetch(`/api/vps/${vm.id}/blast-radius`).catch(() => ({
      totalResources: 0,
      servers: [],
    }));

    setConfirmRequest((prev) => (prev ? { ...prev, blastRadius } : prev));
  }

  async function runConfirmed(hostname, acknowledged) {
    const request = confirmRequest;
    setConfirmRequest(null);
    if (!request) return;

    setBusy(request.vm.id);
    try {
      const result = await request.perform(hostname, acknowledged);
      pushEvent('info', `[VPS ${request.vm.hostname}] ${result?.operation || 'operacao'} solicitada.`);
      await load();
    } catch (actionError) {
      pushEvent('error', `[VPS ${request.vm.hostname}] ${actionError.message || 'falha na operacao.'}`);
    } finally {
      setBusy('');
    }
  }

  function powerAction(vm, action) {
    const labels = { start: 'Ligar', stop: 'Desligar', restart: 'Reiniciar' };
    openConfirmation({
      vm,
      title: `${labels[action]} a VPS`,
      confirmLabel: labels[action],
      irreversible: false,
      perform: (hostname) =>
        apiFetch(`/api/vps/${vm.id}/power/${action}`, {
          method: 'POST',
          body: JSON.stringify({ confirmHostname: hostname }),
        }),
    });
  }

  function snapshotAction(vm, kind) {
    const config = {
      create: { title: 'Criar snapshot da VPS', label: 'Criar snapshot', irreversible: false, method: 'POST', path: 'snapshot' },
      delete: { title: 'Apagar snapshot da VPS', label: 'Apagar snapshot', irreversible: false, method: 'DELETE', path: 'snapshot' },
      restore: { title: 'RESTAURAR snapshot da VPS', label: 'Restaurar', irreversible: true, method: 'POST', path: 'snapshot/restore' },
    }[kind];

    openConfirmation({
      vm,
      title: config.title,
      confirmLabel: config.label,
      irreversible: config.irreversible,
      pointLabel: restorePoints[vm.id]?.snapshot?.created_at,
      perform: (hostname, acknowledged) =>
        apiFetch(`/api/vps/${vm.id}/${config.path}`, {
          method: config.method,
          body: JSON.stringify({
            confirmHostname: hostname,
            acknowledgeDataLoss: acknowledged === true,
          }),
        }),
    });
  }

  function restoreBackup(vm, backup) {
    openConfirmation({
      vm,
      title: 'RESTAURAR backup da VPS',
      confirmLabel: 'Restaurar backup',
      irreversible: true,
      pointLabel: backup.created_at || backup.date,
      perform: (hostname, acknowledged) =>
        apiFetch(`/api/vps/${vm.id}/backups/${backup.id}/restore`, {
          method: 'POST',
          body: JSON.stringify({
            confirmHostname: hostname,
            acknowledgeDataLoss: acknowledged === true,
          }),
        }),
    });
  }

  async function loadRestorePoints(vmId) {
    try {
      const payload = await apiFetch(`/api/vps/${vmId}/restore-points`);
      setRestorePoints((prev) => ({ ...prev, [vmId]: payload }));
    } catch (fetchError) {
      pushEvent('error', `Falha ao listar pontos de restauracao: ${fetchError.message}`);
    }
  }

  if (state.loading) {
    return <div className="empty-box">Carregando infraestrutura...</div>;
  }

  return (
    <div className="vps-panel">
      {confirmRequest && (
        <ConfirmVpsDialog
          request={confirmRequest}
          onCancel={() => setConfirmRequest(null)}
          onConfirm={runConfirmed}
        />
      )}

      <div className="vps-toolbar">
        <div className="window-picker" role="group" aria-label="Janela de tempo">
          {WINDOWS.map((option) => (
            <button
              key={option.id}
              className={`log-tab ${windowHours === option.id ? 'active' : ''}`}
              onClick={() => setWindowHours(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="vps-collected">
          {state.lastCollectedAt
            ? `Coletado ${new Date(state.lastCollectedAt).toLocaleTimeString('pt-BR')}`
            : 'Aguardando primeira coleta'}
        </span>
      </div>

      {error && <div className="error-box">{error}</div>}

      {state.machines.length === 0 && (
        <div className="empty-box">Nenhuma maquina virtual encontrada na conta Hostinger.</div>
      )}

      {state.machines.map((vm) => {
        const series = seriesByVm[vm.id] || [];
        const metrics = vm.metrics || {};
        const points = restorePoints[vm.id];

        return (
          <section key={vm.id} className="vps-card">
            <header className="vps-head">
              <div>
                <div className="resource-title">{vm.hostname || vm.id}</div>
                <div className="resource-meta">
                  {vm.ipv4 || 'sem ip'} | {vm.plan || 'plano n/d'} | estado: {vm.state}
                  {' | '}no ar ha {formatUptime(metrics.uptimeSeconds)}
                </div>
                <div className="resource-meta">
                  {vm.linkedServers?.length
                    ? `Coolify: ${vm.linkedServers.map((server) => server.name).join(', ')}`
                    : 'Nao correlacionado a nenhum servidor do Coolify'}
                </div>
              </div>
              <div className="vps-actions">
                <button className="btn" disabled={busy === vm.id} onClick={() => powerAction(vm, 'start')}>
                  Ligar
                </button>
                <button className="btn warn" disabled={busy === vm.id} onClick={() => powerAction(vm, 'restart')}>
                  Reiniciar
                </button>
                <button className="btn warn" disabled={busy === vm.id} onClick={() => powerAction(vm, 'stop')}>
                  Desligar
                </button>
              </div>
            </header>

            {vm.alerts?.length > 0 && (
              <div className="attention-banner">
                {vm.alerts.map((alert) => alert.message).join(' · ')}
                {vm.linkedServers?.length > 0 &&
                  ` — afeta ${vm.linkedServers.map((server) => server.name).join(', ')}`}
              </div>
            )}

            <div className="metric-grid">
              {METRICS.map((metric) => (
                <MetricTile
                  key={metric.key}
                  metric={metric}
                  series={series}
                  current={metrics[`${metric.key}Pct`]}
                  threshold={state.thresholds[metric.thresholdKey]}
                />
              ))}
              <div className="metric-tile role-normal">
                <div className="metric-head">
                  <span className="metric-label">Rede</span>
                  <span className="metric-value small">
                    ↓ {formatBytes(metrics.netIn)} · ↑ {formatBytes(metrics.netOut)}
                  </span>
                </div>
                <MetricChart
                  points={series.map((sample) => ({ t: sample.t, v: sample.netIn }))}
                  max={null}
                  unit="bytes"
                  role="normal"
                />
                <div className="metric-foot">
                  <span className="metric-flag normal">trafego de entrada</span>
                </div>
              </div>
            </div>

            <details
              className="history-item vps-restore"
              onToggle={(event) => {
                if (event.target.open && !points) {
                  loadRestorePoints(vm.id);
                }
              }}
            >
              <summary>Snapshots e backups (operacoes irreversiveis)</summary>
              <div className="vps-restore-body">
                <div className="vps-restore-row">
                  <span>
                    Snapshot:{' '}
                    {points?.snapshot
                      ? new Date(points.snapshot.created_at || Date.now()).toLocaleString('pt-BR')
                      : 'nenhum'}
                  </span>
                  <div className="inline-actions">
                    <button className="btn" onClick={() => snapshotAction(vm, 'create')}>
                      Criar
                    </button>
                    {points?.snapshot && (
                      <>
                        <button className="btn" onClick={() => snapshotAction(vm, 'delete')}>
                          Apagar
                        </button>
                        <button className="btn danger" onClick={() => snapshotAction(vm, 'restore')}>
                          Restaurar
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {(points?.backups || []).map((backup) => (
                  <div key={backup.id} className="vps-restore-row">
                    <span>
                      Backup de{' '}
                      {backup.created_at
                        ? new Date(backup.created_at).toLocaleString('pt-BR')
                        : backup.id}
                    </span>
                    <button className="btn danger" onClick={() => restoreBackup(vm, backup)}>
                      Restaurar
                    </button>
                  </div>
                ))}

                {points && !points.snapshot && (points.backups || []).length === 0 && (
                  <div className="empty-box small">Nenhum ponto de restauracao disponivel.</div>
                )}
              </div>
            </details>
          </section>
        );
      })}
    </div>
  );
}
