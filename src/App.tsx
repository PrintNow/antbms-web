import { useEffect, useRef, useState } from 'react'
import { Alert, Badge, Button, Progress } from '@mantine/core'
import { BatteryCharging, Bluetooth, ShieldCheck } from 'lucide-react'
import { AntBmsConnection, type BmsStatus } from './antBms'
import { formatMinutes } from './protocol'

type DashboardData = Partial<BmsStatus>
type ConnectionPhase = 'idle' | 'connecting' | 'ready' | 'error'

interface ConnectionState {
  phase: ConnectionPhase
  message: string
  channel: string
}

const EMPTY_DATA: DashboardData = { state: '—', cellVoltages: [], temperatures: [], protectionBits: [], warningBits: [], balanceBits: [] }

function display(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

interface MetricCardProps { label: string; value: string; unit?: string; wide?: boolean }

function MetricCard({ label, value, unit, wide = false }: MetricCardProps) {
  return <article className={`metric-card ${wide ? 'metric-card--wide' : ''}`}><span>{label}</span><strong>{value} {unit && <small>{unit}</small>}</strong></article>
}

function mosLabel(value: number | undefined): string {
  if (value === 1) return '开启'
  if (value === 0) return '关闭'
  return value === undefined ? '—' : `状态 ${value}`
}

function secondsToText(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const days = Math.floor(value / 86400)
  const hours = Math.floor((value % 86400) / 3600)
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时`
}

function currentDirection(data: DashboardData): string {
  if (data.state === '充电') return '充电'
  if (data.state === '放电') return '放电'
  if (data.state === '静置' || data.state === '待机') return '静置'
  return '状态待确认'
}

function chargeTime(data: DashboardData): string {
  if (data.state !== '充电' && !data.chargerOnline) return '暂不可用'
  return formatMinutes(data.chargeRemainingMinutes) ?? '暂不可用'
}

export default function App() {
  const connection = useRef<AntBmsConnection | null>(null)
  const [data, setData] = useState(EMPTY_DATA)
  const [connectionInfo, setConnectionInfo] = useState<ConnectionState>({ phase: 'idle', message: '保护板正在待命。开启蓝牙后，点“找保护板”。', channel: '—' })

  useEffect(() => () => connection.current?.close(), [])

  async function toggleConnection() {
    if (connection.current) {
      connection.current.close()
      connection.current = null
      setConnectionInfo({ phase: 'idle', message: '已断开。保护板继续安静守护电池。', channel: '—' })
      return
    }
    try {
      setConnectionInfo({ phase: 'connecting', message: '请在弹窗里选择你的 ANT BMS…', channel: '—' })
      const next = new AntBmsConnection((status) => {
        setData(status)
        setConnectionInfo((current) => ({ ...current, phase: 'ready', message: '数据已到位，每 2 秒刷新一次。' }))
      })
      connection.current = next
      const info = await next.connect()
      setConnectionInfo({ phase: 'ready', message: `已连接 ${info.deviceName}，正在读取数据。`, channel: info.channel })
    } catch (error) {
      connection.current?.close()
      connection.current = null
      const message = error instanceof Error ? error.message : '请重试'
      setConnectionInfo({ phase: 'error', message: `连接失败：${message}`, channel: '—' })
    }
  }

  const connected = connectionInfo.phase === 'ready' || connectionInfo.phase === 'connecting'
  const soc = Number.isFinite(data.soc) ? Math.max(0, Math.min(100, data.soc!)) : 0

  return <main className="app-shell">
    <header className="topbar">
      <div><p className="eyebrow">ANT BMS · WEB BLUETOOTH</p><h1>电池小管家 <span>🐜</span></h1><p className="subtitle">一眼看电量，少一点心慌。</p></div>
      <Button className="connect-button desktop-button" leftSection={<Bluetooth size={17} />} onClick={toggleConnection} loading={connectionInfo.phase === 'connecting'}>{connected ? '断开连接' : '连接保护板'}</Button>
    </header>

    <div className="utility-row"><Badge className="read-only" leftSection={<ShieldCheck size={14} />} variant="light">只读监测 · 不改参数</Badge><span className="refresh-note">自适应刷新 · 活动时 0.8 秒</span></div>
    <Alert className={`connection-state connection-state--${connectionInfo.phase}`} variant="light" color={connectionInfo.phase === 'error' ? 'red' : connectionInfo.phase === 'ready' ? 'teal' : 'gray'} icon={<span className="state-dot" />}>
      {connectionInfo.message}
    </Alert>

    <section className="dashboard">
      <article className="soc-card">
        <div className="spark">⚡</div><p>当前电量 · SOC</p>
        <div className="soc-number">{Number.isFinite(data.soc) ? data.soc : '—'}<small>%</small></div>
        <Progress className="charge-rail" value={soc} color="teal" radius="xl" aria-label="电量进度" />
        <div className="micro-grid"><div><span>运行状态</span><strong>{data.state}</strong></div><div><span>电池串数</span><strong>{data.cellCount ? `${data.cellCount} 串` : '—'}</strong></div><div><span>通信通道</span><strong title={connectionInfo.channel}>{connectionInfo.channel}</strong></div></div>
      </article>
      <section className="metrics">
        <MetricCard label="总容量" value={display(data.totalAh)} unit="Ah" />
        <MetricCard label="剩余能量" value={display(data.remainingAh)} unit="Ah" />
        <MetricCard label={`实时电流 · ${currentDirection(data)}`} value={display(data.current, 1)} unit="A" />
        <MetricCard label="SOH / 实时功率" value={`${display(data.soh, 0)} %`} unit={Number.isFinite(data.power) ? `${display(data.power, 0)} W` : ''} />
        <MetricCard label="充电状态" value={data.state === '充电' ? '充电中' : data.state ?? '—'} />
        <MetricCard label="充电剩余时间" value={chargeTime(data)} />
      </section>
    </section>
    <section className="detail-grid">
      <article className="detail-panel detail-panel--cells"><div className="panel-heading"><div><p>单体电压</p><h2>电压概览</h2></div><span>{data.cellCount ? `${data.cellCount} 串` : '—'}</span></div>
        <div className="summary-row"><div><span>最高</span><b>{display(data.cellHigh, 3)} V</b></div><div><span>最低</span><b>{display(data.cellLow, 3)} V</b></div><div><span>压差</span><b>{display(data.cellDifference, 3)} V</b></div></div>
        <div className="cell-list">{data.cellVoltages?.length ? data.cellVoltages.map((value, index) => <span key={index}>#{index + 1}<b>{value.toFixed(3)} V</b></span>) : <em>连接后显示每串电芯电压</em>}</div>
      </article>
      <article className="detail-panel"><div className="panel-heading"><div><p>温度与 MOS</p><h2>温度与开关状态</h2></div><span>🌡️</span></div>
        <div className="key-values"><div><span>MOS 温度</span><b>{display(data.mosTemperature, 0)} °C</b></div><div><span>均衡温度</span><b>{display(data.balanceTemperature, 0)} °C</b></div><div><span>充电 MOS</span><b>{mosLabel(data.chargeMos)}</b></div><div><span>放电 MOS</span><b>{mosLabel(data.dischargeMos)}</b></div><div><span>充电器</span><b>{data.chargerOnline === undefined ? '暂不可用' : data.chargerOnline ? '在线' : '离线'}</b></div><div><span>充电器输出</span><b>{data.chargerOutputVoltage === undefined || data.chargerOutputCurrent === undefined ? '暂不可用' : `${display(data.chargerOutputVoltage, 1)} V / ${display(data.chargerOutputCurrent, 1)} A`}</b></div></div>
        <div className="sensor-row">{data.temperatures?.length ? data.temperatures.map((value, index) => <span key={index}>T{index + 1} <b>{value}°</b></span>) : <em>温度传感器数据待连接</em>}</div>
      </article>
      <article className="detail-panel"><div className="panel-heading"><div><p>运行与安全</p><h2>保护与告警</h2></div><span>🛡️</span></div>
        <div className="key-values"><div><span>累计循环容量</span><b>{display(data.totalCycleAh, 1)} Ah</b></div><div><span>累计运行</span><b>{secondsToText(data.runtimeSeconds)}</b></div><div><span>均衡单体</span><b>{data.balanceBits?.length ? `${data.balanceBits.length} 串` : '无'}</b></div><div><span>权限等级</span><b>{data.permissions ?? '—'}</b></div></div>
        <div className="safety-row"><span className={data.protectionBits?.length ? 'has-alert' : ''}>保护 {data.protectionBits?.length ? `#${data.protectionBits.join('、#')}` : '正常'}</span><span className={data.warningBits?.length ? 'has-warning' : ''}>告警 {data.warningBits?.length ? `#${data.warningBits.join('、#')}` : '无'}</span></div>
      </article>
    </section>
    <aside className="tip"><b>手机使用：</b>推荐 Android Chrome / Edge；连接后页面只会发送状态查询，不会改 BMS 设置。</aside>
    <p className="footer-note">数据仅显示在当前页面；断开连接后停止读取。</p>
    <Button className="connect-button mobile-button" leftSection={<BatteryCharging size={18} />} onClick={toggleConnection} loading={connectionInfo.phase === 'connecting'}>{connected ? '断开连接' : '连接保护板'}</Button>
  </main>
}
