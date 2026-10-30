// One screenshot supplies one attempted input. No AX, DOM or clipboard reader.
export class VisualContext {
 constructor({now=Date.now,maxAge=60000}={}){this.now=now;this.maxAge=maxAge}
 clear(){this.last=undefined}
 issue(app,result,image,agent){
  const rect=result.capture_rect
  if(!['macos-window','macos-display'].includes(result.capture_source)||typeof result.screenshot_id!=='string'||!/^[a-f0-9]{64}$/.test(result.visual_stamp??'')||!rect||!['x','y','width','height'].every(k=>Number.isFinite(rect[k]))||rect.width<=0||rect.height<=0||![image.width,image.height].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('Helper does not support bound visual input; update the helper')
  this.last={agent,app:{...app},id:result.screenshot_id,created:this.now(),context:{window_id:result.window_id??0,display_id:result.display_id??0,scope:result.capture_source==='macos-window'?'window':'display',rect:{...rect},visual_stamp:result.visual_stamp,visual_sample:result.visual_sample,visual_focus_sample:result.visual_focus_sample,image_width:image.width,image_height:image.height,front_window_id:result.front_window_id??0}}
 }
 peek(id,agent){const last=this.last;if(!last||last.id!==id||last.agent!==agent||this.now()-last.created>this.maxAge)return null;return last}
 consume(id,agent){const last=this.peek(id,agent);this.clear();return last}
}
