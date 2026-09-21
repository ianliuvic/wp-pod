/** POD 设计拍平输入 · 运维面板（只读统计 + 待与 SDS 交互列表） */
export function intakeOpsPage(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>POD intakes · 待与 SDS 交互</title>
<style>
 :root{color-scheme:light}
 body{margin:0;padding:20px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#171717;background:#fafafa}
 h1{font-size:18px;margin:0 0 4px} .sub{color:#666;margin-bottom:16px}
 .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
 button,input,select{font:inherit;padding:5px 9px;border:1px solid #ccc;border-radius:6px;background:#fff}
 button{cursor:pointer} button.primary{background:#1990c6;border-color:#1990c6;color:#fff}
 .cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
 .card{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:10px 14px;min-width:110px}
 .card b{display:block;font-size:20px} .card span{color:#666}
 table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden}
 th,td{padding:7px 9px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
 th{background:#f3f4f6;font-weight:600;white-space:nowrap}
 tr:last-child td{border-bottom:0}
 code{background:#f3f4f6;padding:1px 4px;border-radius:4px;font-size:12px}
 .pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;background:#eee}
 .pill.pending{background:#fff3cd;color:#8a6d3b} .pill.cart_added{background:#d7f5dd;color:#1d6b32}
 .pill.failed{background:#fde2e2;color:#8b1a1a} .pill.ordered{background:#e0eaff;color:#22409a}
 .muted{color:#888}
</style></head><body>
<h1>POD 设计拍平输入 · 待与 SDS 交互</h1>
<div class="sub">每个 SP 订单在设计器点 Complete design 时落一条 intake；这里看每天新增、还没跟 SDS 交互的量。</div>
<div class="bar">
  <label>日期 <input type="date" id="date"></label>
  <label>趋势天数 <select id="days"><option>7</option><option selected>14</option><option>30</option></select></label>
  <label>状态 <select id="status">
    <option value="pending" selected>pending（未与 SDS 交互）</option>
    <option value="">全部</option>
    <option value="cart_added">cart_added</option>
    <option value="failed">failed</option>
  </select></label>
  <button class="primary" id="reload">刷新</button>
  <button id="copy">复制本页 JSON</button>
</div>
<div class="cards" id="cards"></div>
<h3>明细</h3>
<div id="table"></div>
<h3>趋势</h3>
<div id="trend"></div>
<script>
var last=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function card(label,value){return '<div class="card"><b>'+value+'</b><span>'+label+'</span></div>'}
async function load(){
  var date=document.getElementById('date').value||new Date().toISOString().slice(0,10);
  var days=document.getElementById('days').value;
  var status=document.getElementById('status').value;
  var stats=await (await fetch('/v1/intakes/stats?days='+days+'&date='+date,{cache:'no-store'})).json();
  var list=await (await fetch('/v1/intakes?limit=200&date='+date+(status?('&status='+status):''),{cache:'no-store'})).json();
  last={date:date,stats:stats,list:list};
  var t=stats.today||{};
  document.getElementById('cards').innerHTML=
    card(date+' 新增',t.created||0)+card('待与 SDS 交互',t.pending||0)+card('已加购',t.cartAdded||0)+
    card('失败',t.failed||0)+card('已下单条数',t.ordered||0)+card('下单件数',t.orderUnits||0);
  var rows=(list.items||[]).map(function(it){
    var tags=(it.orders&&it.orders.length)?'<span class="pill ordered">order '+esc(it.orders[0].orderName||it.orders[0].orderId||'')+' · '+esc(it.orders[0].size||'')+' x'+esc(it.orders[0].quantity)+'</span>':'';
    return '<tr><td><code>'+esc(it.id)+'</code></td><td>'+esc(it.createdAt)+'</td><td>'+esc(it.productId)+(it.productName?('<br><span class="muted">'+esc(it.productName)+'</span>'):'')+'</td>'+
      '<td>'+esc(it.modeKind)+(it.templateName?('<br><span class="muted">'+esc(it.templateName)+'</span>'):'')+'</td>'+
      '<td>'+(it.sides||[]).map(function(s){return '<a href="'+esc(s.url)+'" target="_blank">'+esc(s.name||s.sideId)+'</a> <span class="muted">'+esc(s.width)+'x'+esc(s.height)+'</span>'}).join('<br>')+'</td>'+
      '<td><span class="pill '+esc(it.status)+'">'+esc(it.status)+'</span> '+tags+(it.error?('<br><span class="muted">'+esc(it.error)+'</span>'):'')+'</td>'+
      '<td>'+(it.designId?('<code>'+esc(it.designId)+'</code>'):'<span class="muted">-</span>')+'</td></tr>';
  }).join('');
  document.getElementById('table').innerHTML='<table><thead><tr><th>intake</th><th>创建时间</th><th>商品</th><th>模式</th><th>拍平面</th><th>状态</th><th>designId</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<p class="muted">共 '+esc(list.total||0)+' 条（最多显示 200）</p>';
  document.getElementById('trend').innerHTML='<table><thead><tr><th>日期</th><th>新增</th><th>待交互</th><th>已加购</th><th>失败</th><th>已下单</th><th>件数</th></tr></thead><tbody>'+
    (stats.days||[]).map(function(d){return '<tr><td>'+esc(d.date)+'</td><td>'+d.created+'</td><td>'+d.pending+'</td><td>'+d.cartAdded+'</td><td>'+d.failed+'</td><td>'+d.ordered+'</td><td>'+d.orderUnits+'</td></tr>'}).join('')+
    '</tbody></table>';
}
document.getElementById('date').value=new Date().toISOString().slice(0,10);
document.getElementById('reload').onclick=load;
document.getElementById('copy').onclick=function(){navigator.clipboard.writeText(JSON.stringify(last,null,2))};
load();
</script>
</body></html>`;
}
