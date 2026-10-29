import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {connect} from 'node:net'
import {OriginProxy} from '../src/origin-proxy.js'

test('CONNECT preserves ws/http scope and handles a fragmented first request',async t=>{
  let connections=0
  const server=createServer((_req,res)=>res.end('allowed-upstream'))
  server.on('connection',()=>connections++)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  const owner={config:{startupTimeoutMs:1500},networkDenied:[],checkUrl(value){if(new URL(value).origin!==origin)throw Error('denied')},error:(code,message)=>Object.assign(Error(message),{code})}
  const proxy=new OriginProxy(owner);await proxy.start()
  t.after(async()=>{await proxy.dispose();await new Promise(resolve=>server.close(resolve))})
  async function request(chunks){
    const url=new URL(proxy.url),socket=connect({host:url.hostname,port:Number(url.port)})
    const received=[];socket.on('data',chunk=>received.push(chunk));socket.on('error',()=>{})
    const closed=new Promise(resolve=>socket.once('close',()=>resolve(Buffer.concat(received).toString())))
    const timer=setTimeout(()=>socket.destroy(),2000)
    try{
      await new Promise(resolve=>socket.once('connect',resolve))
      const accepted=new Promise(resolve=>socket.once('data',resolve))
      socket.write('CONNECT '+new URL(origin).host+' HTTP/1.1\r\nHost: '+new URL(origin).host+'\r\n\r\n')
      assert.match((await accepted).toString(),/200 Connection Established/)
      for(const chunk of chunks){socket.write(chunk);await new Promise(resolve=>setTimeout(resolve,2))}
      return await closed
    }finally{clearTimeout(timer);socket.destroy()}
  }
  // TLS is not authorized merely because the same physical HTTP port is.
  await request([Buffer.from([0x16,0x03,0x01,0x00,0x01,0x00])])
  assert.equal(connections,0)
  const response=await request(['G','E','T',' / HTTP/1.1\r\nHost: '+new URL(origin).host+'\r\nConnection: close\r\n\r\n'])
  assert.equal(connections,1)
  assert.match(response,/allowed-upstream/)
})
