import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

// Chrome uses this loopback proxy for native HTTP/HTTPS and ws/wss, including
// sockets created in workers. It does not decrypt TLS. HTTP/2 and QUIC are
// disabled in the owned browser so a tunnel cannot be coalesced across origins.
export class OriginProxy {
  constructor(session) { this.session=session;this.sockets=new Set();this.closing=false }

  async start(signal) {
    const server=createServer((req,res)=>this.forward(req,res))
    this.server=server
    server.on('connection',socket=>this.track(socket))
    server.on('upgrade',(req,socket,head)=>this.upgrade(req,socket,head))
    server.on('connect',(req,socket,head)=>this.tunnel(req,socket,head))
    server.on('clientError',(_error,socket)=>socket.destroy())
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    server.on('error',()=>{if(!this.closing){this.session.guardError=this.session.error('NETWORK_GUARD_LOST','Browser origin proxy failed.');void this.session.shutdown().catch(()=>{})}})
    server.on('close',()=>{if(!this.closing){this.session.guardError=this.session.error('NETWORK_GUARD_LOST','Browser origin proxy closed.');void this.session.shutdown().catch(()=>{})}})
    if(signal?.aborted || this.session.stopped){await this.dispose();signal?.throwIfAborted();throw this.session.error('ABORTED','Browser startup stopped.')}
    this.url=`http://127.0.0.1:${server.address().port}`
    return this.url
  }

  track(socket) { if(this.closing){socket.destroy();return}this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));socket.on('error',()=>{}) }
  deny(value) {
    let origin='opaque';try{origin=new URL(value).origin}catch{}
    this.session.networkDenied.push(origin)
    if(this.session.networkDenied.length>100)this.session.networkDenied.shift()
  }
  target(value) {
    const url=new URL(value)
    if(url.protocol==='ws:'){this.session.checkWebSocketUrl(value);url.protocol='http:'}
    else this.session.checkUrl(value)
    if(url.protocol!=='http:')throw this.session.error('ORIGIN_DENIED','TLS must use an origin-checked CONNECT tunnel.')
    return url
  }
  headers(req,url) {
    const headers={...req.headers,host:url.host}
    delete headers['proxy-connection'];delete headers['proxy-authorization']
    return headers
  }
  respond(socket,status,message) {
    if(!socket.destroyed)socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
  }

  forward(req,res) {
    let url
    try{if(this.closing)throw Error('closed');url=this.target(req.url)}
    catch{this.deny(req.url);res.writeHead(403);res.end('Browser origin denied');return}
    const upstream=httpRequest(url,{method:req.method,headers:this.headers(req,url),agent:false})
    upstream.on('socket',socket=>this.track(socket))
    upstream.on('response',response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)})
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy())
    res.on('close',()=>upstream.destroy())
    req.pipe(upstream) // Native request body and method; never replay or redirect.
  }

  upgrade(req,socket,head) {
    let url
    try{if(this.closing)throw Error('closed');url=this.target(req.url)}
    catch{this.deny(req.url);this.respond(socket,'403 Forbidden','Browser origin denied');return}
    const upstream=httpRequest(url,{method:req.method,headers:this.headers(req,url),agent:false})
    upstream.on('socket',connection=>this.track(connection))
    upstream.on('upgrade',(response,remote,remoteHead)=>{
      let headers=`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`
      for(let i=0;i<response.rawHeaders.length;i+=2)headers+=`${response.rawHeaders[i]}: ${response.rawHeaders[i+1]}\r\n`
      socket.write(headers+'\r\n')
      if(remoteHead.length)socket.write(remoteHead)
      if(head.length)remote.write(head)
      socket.pipe(remote);remote.pipe(socket)
      socket.on('close',()=>remote.destroy());remote.on('close',()=>{if(!remote.readableEnded)socket.destroy()})
    })
    upstream.on('response',response=>{response.resume();this.respond(socket,'502 Bad Gateway','WebSocket upgrade failed')})
    upstream.on('error',()=>socket.destroy())
    socket.on('close',()=>upstream.destroy())
    upstream.end()
  }

  tunnel(req,socket,head) {
    const authority=req.url
    const allowed=scheme=>{try{this.session.checkUrl(`${scheme}//${authority}`);return true}catch{return false}}
    try{
      if(this.closing || !/^(?:\[[0-9a-fA-F:.]+\]|[^:/?#@\s]+):\d{1,5}$/.test(authority) || !allowed('http:')&&!allowed('https:'))throw Error('Invalid or denied CONNECT authority')
    }catch{this.deny('https://'+req.url);this.respond(socket,'403 Forbidden','Browser origin denied');return}
    // Chromium also uses CONNECT for plaintext ws:. Classify the first TLS
    // handshake or HTTP GET BEFORE connecting upstream, so allowing http: does
    // not accidentally allow https: (or the reverse) on the same host/port.
    let prefix=Buffer.alloc(0)
    const timer=setTimeout(()=>socket.destroy(),this.session.config.startupTimeoutMs)
    socket.once('close',()=>clearTimeout(timer))
    const first=chunk=>{
      prefix=Buffer.concat([prefix,chunk])
      if(prefix.length<4){socket.once('data',first);socket.resume();return}
      socket.pause();clearTimeout(timer)
      const tls=prefix[0]===0x16&&prefix[1]===0x03
      if(!tls && prefix.subarray(0,4).toString()!=='GET '){socket.destroy();return}
      const scheme=tls?'https:':'http:'
      if(!allowed(scheme)){this.deny(`${scheme}//${authority}`);socket.destroy();return}
      const url=new URL(`${scheme}//${authority}`)
      const remote=connect({host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port||(tls?443:80))})
      this.track(remote)
      remote.once('connect',()=>{
        if(socket.destroyed){remote.destroy();return}
        remote.write(prefix);socket.pipe(remote);remote.pipe(socket);socket.resume()
      })
      remote.on('error',()=>socket.destroy())
      socket.on('close',()=>remote.destroy());remote.on('close',()=>{if(!remote.readableEnded)socket.destroy()})
    }
    if(head.length){socket.pause();first(head)}else socket.once('data',first)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  }

  async dispose() {
    this.closing=true
    for(const socket of this.sockets)socket.destroy()
    if(this.server?.listening)await new Promise(resolve=>this.server.close(resolve))
  }
}
