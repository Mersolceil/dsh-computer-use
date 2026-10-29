import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

export async function startLab({ port = 4173, visionCode = 'A7K2P9', tabCode = 'TAB829', visualTarget = {x:360,y:140} } = {}) {
  if (!/^[A-Z0-9]{6}$/.test(visionCode)) throw new Error('visionCode must contain 6 uppercase letters/digits')
  if (!/^[A-Z0-9]{6}$/.test(tabCode)) throw new Error('tabCode must contain 6 uppercase letters/digits')
  if (![visualTarget.x,visualTarget.y].every(Number.isSafeInteger) || visualTarget.x<150 || visualTarget.x>650 || visualTarget.y<70 || visualTarget.y>200) throw new Error('visualTarget must be inside the lab canvas')
  const state = { submissions: 0, items: [], last: null, popupSubmissions:0, popupNote:null, uploads:[] }
  let releaseDelayedTab
  const delayedTabGate=new Promise(resolve=>{releaseDelayedTab=resolve})
  const html = await readFile(new URL('./lab.html', import.meta.url))
  const advanced = await readFile(new URL('./advanced.html', import.meta.url))
  const server = createServer(async (req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end() }
    if (req.url === '/advanced') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(advanced) }
    if (req.url === '/uploads') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(await readFile(new URL('./uploads.html', import.meta.url))) }
    if (req.url === '/api/upload' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 200000) { res.writeHead(413); return res.end() } }
      try { state.uploads.push(JSON.parse(body)) } catch { res.writeHead(400); return res.end() }
      res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({saved:true}))
    }
    if (req.url === '/tabs') {
      res.setHeader('Content-Type','text/html; charset=utf-8')
      return res.end('<!doctype html><meta charset="utf-8"><title>标签页收集台</title><h1>订单工作台</h1><a href="/tab-detail" target="_blank">打开订单明细</a><label>核对码<input id="code"></label><button id="save">保存核对码</button><output>尚未保存核对码</output><form action="/popup-submit" method="post" target="_blank"><label>备注<input name="note"></label><button>打开提交结果</button></form><script>document.querySelector("#save").onclick=async()=>{const code=document.querySelector("#code").value;await fetch("/api/submit",{method:"POST",body:JSON.stringify({kind:"tab-check",code})});document.querySelector("output").textContent="核对已保存："+code}</script>')
    }
    if(req.url==='/tab-delayed'){
      await delayedTabGate
      res.setHeader('Content-Type','text/html; charset=utf-8')
      return res.end('<!doctype html><meta charset="utf-8"><title>延迟明细</title><h1>延迟页面已就绪</h1>')
    }
    if (req.url === '/tab-detail') {
      res.setHeader('Content-Type','text/html; charset=utf-8')
      return res.end(`<!doctype html><meta charset="utf-8"><title>订单明细</title><h1>订单明细</h1><p>本轮核对码：${tabCode}</p><label>备注<input></label><button onclick="window.close()">关闭明细页</button>`)
    }
    if (req.url === '/popup-submit' && req.method==='POST') {
      let body='';for await(const chunk of req){body+=chunk;if(body.length>20000){res.writeHead(413);return res.end()}}
      state.popupSubmissions++;state.popupNote=new URLSearchParams(body).get('note')
      res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><title>提交结果</title><h1>表单已接收</h1><output>弹窗提交成功</output>')
    }
    if (req.url === '/history-a' || req.url === '/history-b') {
      const a=req.url==='/history-a'
      res.setHeader('Content-Type','text/html; charset=utf-8')
      return res.end(`<!doctype html><meta charset="utf-8"><title>历史页面${a?'甲':'乙'}</title><h1>历史页面${a?'甲':'乙'}</h1><a href="/history-${a?'b':'a'}">打开页面${a?'乙':'甲'}</a><label>备忘<input></label>`)
    }
    if (req.url === '/load-ready') {
      res.setHeader('Content-Type','text/html; charset=utf-8')
      return res.end('<!doctype html><meta charset="utf-8"><button id="ready">需要初始化的按钮</button><output>等待脚本</output><script async src="/late-script.js"></script>')
    }
    if (req.url === '/late-script.js') {
      await new Promise(r=>setTimeout(r,600));res.setHeader('Content-Type','application/javascript')
      return res.end("document.querySelector('output').textContent='脚本已就绪';document.querySelector('button').onclick=()=>document.querySelector('output').textContent='初始化后点击成功';")
    }
    if (req.url === '/frame') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end('<!doctype html><meta charset="utf-8"><title>地址编辑器</title><label>嵌入地址<input id="address"></label><button onclick="document.querySelector(\'output\').textContent=\'嵌入保存成功：\'+document.querySelector(\'input\').value">保存嵌入地址</button><output>尚未保存嵌入地址</output>')
    }
    if (req.url === '/large') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end('<!doctype html><meta charset="utf-8"><title>长页面</title><main aria-label="长页面">' + Array.from({length:150}, (_,i)=>`<section aria-label="条目${i}"><h2>任务${i}</h2><button onclick="document.querySelector(\'output\').textContent=\'已完成任务${i}\'">执行任务${i}</button></section>`).join('') + '<output>尚未执行任务</output></main>')
    }
    if (req.url === '/visual-click') {
      res.setHeader('Content-Type','text/html; charset=utf-8')
      return res.end(`<!doctype html><meta charset="utf-8"><title>视觉点击练习</title><style>body{margin:30px;font:24px system-ui}canvas{display:block}</style><h1>请点击画布中的绿色 CONFIRM 区域一次</h1><canvas width="900" height="350"></canvas><output>尚未确认</output><script>const c=document.querySelector('canvas'),g=c.getContext('2d');g.fillStyle='#edf4fb';g.fillRect(0,0,900,350);g.fillStyle='#999';g.fillRect(10,10,160,60);g.fillStyle='white';g.font='bold 24px sans-serif';g.fillText('CANCEL',30,50);g.fillStyle='#147d3f';g.fillRect(${visualTarget.x},${visualTarget.y},160,80);g.fillStyle='white';g.fillText('CONFIRM',${visualTarget.x+17},${visualTarget.y+48});c.onclick=async e=>{if(e.offsetX>=${visualTarget.x}&&e.offsetX<${visualTarget.x+160}&&e.offsetY>=${visualTarget.y}&&e.offsetY<${visualTarget.y+80}){await fetch('/api/submit',{method:'POST',body:JSON.stringify({kind:'visual-confirm'})});document.querySelector('output').textContent='视觉确认成功'}else document.querySelector('output').textContent='点击未命中，请重新截图'};</script>`)
    }
    if (req.url === '/vision') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end(`<!doctype html><meta charset="utf-8"><title>截图识别练习</title><h1>请读取画布中的六位代码</h1><canvas width="900" height="350"></canvas><script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#edf4fb';c.fillRect(0,0,900,350);c.fillStyle='#102f4d';c.font='bold 90px monospace';c.fillText('${visionCode}',110,210);</script>`)
    }
    if (req.url?.startsWith('/redirect?')) {
      const destination = new URL(req.url, 'http://127.0.0.1').searchParams.get('to')
      res.writeHead(302, { Location: destination || '/' }); return res.end()
    }
    if (req.url === '/api/state') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(state)) }
    if (req.url === '/api/submit' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 20000) { res.writeHead(413); return res.end() } }
      try { state.last = JSON.parse(body) } catch { res.writeHead(400); return res.end() }
      state.submissions++
      state.items.push(state.last)
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ saved: true, count: state.submissions }))
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(html)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { server, state,releaseDelayedTab, origin: `http://127.0.0.1:${server.address().port}`, close: () => {releaseDelayedTab();return new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))} }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lab = await startLab({ port: Number(process.env.PORT || 4173) })
  console.log(`Browser-use lab: ${lab.origin}\nCtrl+C stops the lab. All data is in memory.`)
  const stop = async () => { await lab.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
