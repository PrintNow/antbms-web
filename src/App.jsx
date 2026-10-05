import { useEffect, useRef, useState } from 'react'
import { AntBmsConnection } from './antBms.js'

const EMPTY_DATA = { soc: null, totalAh: null, remainingAh: null, voltage: null, current: null, cellCount: null, state: '—' }

function display(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function MetricCard({ label, value, unit, wide = false }) {
  return <article className={`metric-card ${wide ? 'metric-card--wide' : ''}`}><span>{label}</span><strong>{value} {unit && <small>{unit}</small>}</strong></article>
}

export default function App() {
  const connection = useRef(null)
  const [data, setData] = useState(EMPTY_DATA)
  const [connectionInfo, setConnectionInfo] = useState({ phase: 'idle', message: '保护板正在待命。开启蓝牙后，点“找保护板”。', channel: '—' })

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
      setConnectionInfo({ phase: 'error', message: `连接失败：${error.message || '请重试'}`, channel: '—' })
    }
  }

  const connected = connectionInfo.phase === 'ready' || connectionInfo.phase === 'connecting'
  const soc = Number.isFinite(data.soc) ? Math.max(0, Math.min(100, data.soc)) : 0

  return <main className="app-shell">
    <header className="topbar">
      <div><p className="eyebrow">ANT BMS · WEB BLUETOOTH</p><h1>电池小管家 <span>🐜</span></h1><p className="subtitle">一眼看电量，少一点心慌。</p></div>
      <button className="connect-button desktop-button" onClick={toggleConnection} disabled={connectionInfo.phase === 'connecting'}>{connected ? '断开连接' : '找保护板'}</button>
    </header>

    <div className="read-only"><span>🛡️</span><b>只读模式</b><i>不写参数，不碰保护阈值</i></div>
    <section className={`connection-state connection-state--${connectionInfo.phase}`}><span className="state-dot" /><p>{connectionInfo.message}</p></section>

    <section className="dashboard">
      <article className="soc-card">
        <div className="spark">⚡</div><p>当前电量 · SOC</p>
        <div className="soc-number">{Number.isFinite(data.soc) ? data.soc : '—'}<small>%</small></div>
        <div className="charge-rail" aria-label="电量进度"><span style={{ width: `${soc}%` }} /></div>
        <div className="micro-grid"><div><span>现在在干嘛</span><strong>{data.state}</strong></div><div><span>电池串数</span><strong>{data.cellCount ? `${data.cellCount} 串` : '—'}</strong></div><div><span>通信通道</span><strong title={connectionInfo.channel}>{connectionInfo.channel}</strong></div></div>
      </article>
      <section className="metrics">
        <MetricCard label="总容量" value={display(data.totalAh)} unit="Ah" />
        <MetricCard label="剩余能量" value={display(data.remainingAh)} unit="Ah" />
        <MetricCard label="电压 / 电流" value={`${display(data.voltage)} V`} unit={Number.isFinite(data.current) ? `${display(data.current, 1)} A` : ''} wide />
      </section>
    </section>
    <aside className="tip"><b>手机使用：</b>推荐 Android Chrome / Edge；连接后页面只会发送状态查询，不会改 BMS 设置。</aside>
    <p className="footer-note">数据仅显示在当前页面。断开后，蚂蚁和数据都会各自回家。</p>
    <button className="connect-button mobile-button" onClick={toggleConnection} disabled={connectionInfo.phase === 'connecting'}>{connected ? '断开连接' : '找保护板'}</button>
  </main>
}
