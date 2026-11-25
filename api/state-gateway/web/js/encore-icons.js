/* Encore animated pixel icons — <encore-icon name="server" size="4" state="ok" live></encore-icon> */
(()=>{
const P={c:'#22E3FF',p:'#B26BFF',g:'#3DFF9A',y:'#FFC93D',r:'#FF4D6D',w:'#EAFBFF',n:'#0B1020'};
const rep=(s,n)=>Array(n).fill(s);
const I={
dashboard:[...rep('ccccc..ccccc',5),'','',...rep('ccccc..ppppp',5)],
server:['cccccccccccc','cg..c.c.c.cc','cccccccccccc','','cccccccccccc','cg..c.c.c.cc','cccccccccccc','','cccccccccccc','cg..c.c.c.cc','cccccccccccc'],
database:['..cccccccc..','.cwwwwwwwwc.','cccccccccccc','c..........c','.cccccccccc.','c..........c','.cccccccccc.','c..........c','.cccccccccc.','..cccccccc..'],
cpu:['','...c.c.c.c..','..cccccccc..','.cc......cc.','..c.pppp.c..','.cc.pppp.cc.','..c.pppp.c..','.cc.pppp.cc.','..c......c..','..cccccccc..','...c.c.c.c..'],
network:['....cccc....','....cwwc....','....cccc....','.....cc.....','.cccccccccc.','.c........c.','cccc....cccc','cwwc....cwwc','cccc....cccc'],
cloud:['','','....cccc....','...cccccc...','.cccccccccc.','cccccccccccc','cccccccccccc','.cccccccccc.'],
alert:['.....yy.....','....yyyy....','....yyyy....','...yyyyyy...','...yynnyy...','..yyynnyyy..','..yyynnyyy..','.yyyyyyyyyy.','.yyyynnyyyy.','yyyyyyyyyyyy'],
bell:['.....cc.....','....cccc....','...cccccc...','...cccccc...','..cccccccc..','..cccccccc..','.cccccccccc.','cccccccccccc','','.....yy.....'],
log:['.cccccccccc.','.c........c.','.c.cccccc.c.','.c........c.','.c.cccc...c.','.c........c.','.c.cccccc.c.','.c........c.','.c.pppp...c.','.c........c.','.cccccccccc.'],
settings:['.....cc.....','.c..cccc..c.','.cccccccccc.','..cc....cc..','cccc....cccc','cccc.pp.cccc','cccc....cccc','..cc....cc..','.cccccccccc.','.c..cccc..c.','.....cc.....'],
search:['..cccccc....','.cc....cc...','cc......cc..','c........c..','c........c..','cc......cc..','.cc....cc...','..cccccccc..','........ccc.','.........ccc'],
user:['....cccc....','...cccccc...','...cccccc...','...cccccc...','....cccc....','','..cccccccc..','.cccccccccc.','.cccccccccc.','.cccccccccc.'],
check:['','','..........gg','.........ggg','........ggg.','g......ggg..','gg....ggg...','ggg..ggg....','.gggggg.....','..gggg......','...gg.......'],
error:['','rr........rr','.rr......rr.','..rr....rr..','...rr..rr...','....rrrr....','....rrrr....','...rr..rr...','..rr....rr..','.rr......rr.','rr........rr'],
dot:['..cccc..','.cccccc.','cccccccc','cccccccc','cccccccc','cccccccc','.cccccc.','..cccc..']
};
// loader: 8 blocks in a ring
{const g=Array.from({length:12},()=>Array(12).fill('.'));
for(const[r,c]of[[0,5],[2,8],[5,10],[8,8],[10,5],[8,2],[5,0],[2,2]])for(let a=0;a<2;a++)for(let b=0;b<2;b++)g[r+a][c+b]='c';
I.loader=g.map(r=>r.join(''));}
// logo 16x16
{const N=16,o=(r,c)=>r+c<3||r+N-1-c<3||N-1-r+c<3||N-1-r+N-1-c<3;
const g=Array.from({length:N},(_,r)=>Array.from({length:N},(_,c)=>o(r,c)?'.':[[r+1,c],[r-1,c],[r,c+1],[r,c-1]].some(([a,b])=>a<0||b<0||a>=N||b>=N||o(a,b))?'c':'n'));
const pulse=[[8,2],[8,3],[8,4],[7,5],[4,6],[5,6],[6,6],[7,6],[8,7],[9,7],[10,7],[11,7],[9,8],[8,9],[8,10],[8,11],[8,12]];
pulse.forEach(([r,c])=>g[r][c]='c');g[8][13]='w';g[7][13]='g';g[9][13]='g';
[[2,3],[2,12],[13,3],[13,12]].forEach(([r,c])=>g[r][c]='p');for(let c=5;c<11;c++)g[13][c]='p';
I.logo=g.map(r=>r.join(''));I._pulse=pulse;}
const css=`
encore-icon{display:inline-block;line-height:0;cursor:pointer;vertical-align:middle;--e-c:#22E3FF}
encore-icon[state=ok]{--e-c:#3DFF9A}encore-icon[state=warn]{--e-c:#FFC93D}encore-icon[state=critical]{--e-c:#FF4D6D}encore-icon[state=violet]{--e-c:#B26BFF}
encore-icon svg{display:block;overflow:visible}
encore-icon rect[data-ch=c]{fill:var(--e-c)}
encore-icon g{transform-box:view-box}
@keyframes e-blink{0%,49%{opacity:1}50%,100%{opacity:.15}}
@keyframes e-sweep{0%,18%{opacity:1}19%,100%{opacity:.3}}
@keyframes e-trace{0%{opacity:.2}6%,66%{opacity:1}100%{opacity:.2}}
@keyframes e-trail{0%{opacity:1}12%{opacity:.7}25%{opacity:.5}50%,100%{opacity:.2}}
@keyframes e-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}
@keyframes e-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-.5px)}75%{transform:translateX(.5px)}}
@keyframes e-swing{0%,100%{transform:rotate(0)}25%{transform:rotate(14deg)}75%{transform:rotate(-14deg)}}
@keyframes e-spin{to{transform:rotate(360deg)}}
@keyframes e-scan{0%,100%{transform:translate(0,0)}50%{transform:translate(1px,1px)}}
@keyframes e-pop{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
@keyframes e-warn{0%,49%{fill:#FFC93D}50%,100%{fill:#FF4D6D}}
encore-icon.on[name=dashboard] rect{animation:e-sweep calc(1.2s*var(--spd,1)) steps(1) infinite;animation-delay:calc(.05s*var(--spd,1)*(var(--r) + var(--c)))}
encore-icon.on[name=database] rect{animation:e-sweep calc(1.4s*var(--spd,1)) steps(1) infinite;animation-delay:calc(.1s*var(--spd,1)*var(--r))}
encore-icon.on[name=log] rect,encore-icon.on[name=network] rect{animation:e-sweep calc(1.3s*var(--spd,1)) steps(1) infinite;animation-delay:calc(.1s*var(--spd,1)*var(--r))}
encore-icon.on[name=cpu] rect[data-ch=c]{animation:e-sweep calc(1.2s*var(--spd,1)) steps(1) infinite;animation-delay:calc(.08s*var(--spd,1)*var(--c))}
encore-icon.on[name=cpu] rect[data-ch=p]{animation:e-blink calc(.6s*var(--spd,1)) steps(1) infinite}
encore-icon.on[name=server] rect[data-ch=g]{animation:e-blink calc(.8s*var(--spd,1)) steps(1) infinite;animation-delay:calc(.27s*var(--spd,1)*var(--r))}
encore-icon.on[name=cloud] g,encore-icon.on[name=user] g{animation:e-bob calc(.8s*var(--spd,1)) steps(1) infinite}
encore-icon.on[name=alert] g,encore-icon.on[name=error] g{animation:e-shake calc(.3s*var(--spd,1)) steps(1) infinite}
encore-icon.on[name=alert] rect[data-ch=y]{animation:e-warn calc(.7s*var(--spd,1)) steps(1) infinite}
encore-icon.on[name=bell] g{transform-origin:6px 1px;animation:e-swing calc(.8s*var(--spd,1)) steps(4) infinite}
encore-icon.on[name=settings] g{transform-origin:6px 5.5px;animation:e-spin calc(1.6s*var(--spd,1)) steps(8) infinite}
encore-icon.on[name=search] g{animation:e-scan calc(.8s*var(--spd,1)) steps(1) infinite}
encore-icon.on[name=check] g{transform-origin:6px 6px;animation:e-pop calc(.6s*var(--spd,1)) steps(1) infinite}
encore-icon.on[name=loader] rect{animation:e-trail calc(1s*var(--spd,1)) steps(1) infinite;animation-delay:calc(.125s*var(--spd,1)*var(--i))}
encore-icon.on[name=dot] g{animation:e-blink calc(.9s*var(--spd,1)) steps(1) infinite}
encore-icon.on[name=dot][state=critical] g{animation-duration:calc(.4s*var(--spd,1))}
encore-icon.on[name=logo] rect[data-p]{animation:e-trace calc(1.8s*var(--spd,1)) steps(1) infinite;animation-delay:calc(.07s*var(--spd,1)*var(--p))}
encore-icon.on[name=logo] rect[data-ch=w],encore-icon.on[name=logo] rect[data-ch=g]{animation:e-blink calc(.9s*var(--spd,1)) steps(1) infinite}
`;
const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
class E extends HTMLElement{
static get observedAttributes(){return['name','size']}
connectedCallback(){this.r();if(!this._b){this._b=1;
this.addEventListener('mouseenter',()=>this.classList.add('on'));
this.addEventListener('mouseleave',()=>{if(!this._pin&&!this.hasAttribute('live'))this.classList.remove('on')});
this.addEventListener('click',()=>{this._pin=!this._pin;this.classList.toggle('on',this._pin||this.hasAttribute('live'))})}
if(this.hasAttribute('live'))this.classList.add('on')}
attributeChangedCallback(){if(this.isConnected)this.r()}
r(){const n=this.getAttribute('name'),rows=I[n];if(!rows)return;
const s=+this.getAttribute('size')||4,w=Math.max(...rows.map(x=>x.length)),h=rows.length;
const pm=new Map((I._pulse||[]).map(([r,c],i)=>[r+','+c,i]));let o='';
rows.forEach((row,y)=>{for(let x=0;x<row.length;x++){const ch=row[x];if(!P[ch])continue;
let ex='';if(n==='logo'&&pm.has(y+','+x))ex=` data-p style="--p:${pm.get(y+','+x)}"`;
const ang=Math.atan2(y-5.5,x-5.5)+Math.PI/2,i=Math.round(((ang%(2*Math.PI))+2*Math.PI)%(2*Math.PI)/(Math.PI/4))%8;
o+=`<rect x="${x}" y="${y}" width="1" height="1" data-ch="${ch}" fill="${P[ch]}"${ex} style="--r:${y};--c:${x};--i:${i}${ex?';--p:'+pm.get(y+','+x):''}"/>`}});
this.innerHTML=`<svg viewBox="0 0 ${w} ${h}" width="${w*s}" height="${h*s}" shape-rendering="crispEdges" role="img" aria-label="${n}"><g>${o}</g></svg>`}}
customElements.define('encore-icon',E);
window.EncoreIcons={names:Object.keys(I).filter(k=>k[0]!=='_')};
})();
