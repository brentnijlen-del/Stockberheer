const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
function harness(role='admin',failSave=false){
 const calls=[];const nodes=new Map();
 const el=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='email'?'test@example.invalid':'test-password',textContent:'',innerHTML:'',classList:{add(){},remove(){}}});return nodes.get(id)};
 const context=vm.createContext({fetch:async(url,opts)=>{
  calls.push({url,opts});let result;
  if(url.includes('/token?'))result={access_token:'test-session'};
  else if(url.includes('/app_members'))result=role?[{role}]:[];
  else if(url.includes('/app_state'))result=[{data:{pin:'legacy',userMode:'admin',products:[],locations:[],cases:[],lots:[],moves:[],categories:[],loans:[],shortages:[],processedAlerts:[]}}];
  else result=true;
  return {ok:!(failSave&&url.includes('/rpc/')),status:failSave&&url.includes('/rpc/')?403:200,json:async()=>result};
 },localStorage:{removeItem(){}},document:{getElementById:el},crypto:{randomUUID(){}},alert(){},renderNav(){},show(){},stopProductCameraScan(){}});
 const prefix=html.slice(html.indexOf('const SUPABASE_URL='),html.indexOf('function categoryName'));
 const login=html.slice(html.indexOf('async function login(){'),html.indexOf('function renderNav()'));
 vm.runInContext(prefix+'\n'+login,context);return {context,calls,el};
}
test('no inventory request before login; unauthenticated save is ignored',async()=>{
 const h=harness();await vm.runInContext('save()',h.context);assert.equal(h.calls.length,0);
});
test('membership required before loading private inventory',async()=>{
 const h=harness(null);await vm.runInContext('login()',h.context);
 assert.equal(h.calls.some(c=>c.url.includes('/app_state')),false);
 assert.match(h.el('loginError').textContent,/geen toegang/);
 assert.equal(vm.runInContext('session',h.context),null);
});
test('role comes from server; state writes contain no PIN or role and use session token',async()=>{
 const h=harness('volunteer');await vm.runInContext('login();',h.context);
 assert.equal(vm.runInContext('currentRole',h.context),'volunteer');
 await vm.runInContext('save()',h.context);
 const req=h.calls.find(c=>c.url.includes('/rpc/'));
 assert.equal(req.opts.headers.Authorization,'Bearer test-session');
 const data=JSON.parse(req.opts.body).new_data;
 assert.equal('pin' in data,false);assert.equal('userMode' in data,false);
 assert.equal(h.el('password').value,'');
});
test('rejected save clears session and private state',async()=>{
 const h=harness('admin',true);await vm.runInContext('login()',h.context);
 await vm.runInContext('save()',h.context);
 assert.equal(vm.runInContext('session',h.context),null);
 assert.equal(vm.runInContext('cloudReady',h.context),false);
});
