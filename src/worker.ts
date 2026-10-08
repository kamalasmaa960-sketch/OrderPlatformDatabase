export interface Env {
  ORDER_PLATFORM_DATABASE: DurableObjectNamespace;
  ASSETS: Fetcher;
}

type Role = "customer" | "store" | "driver" | "admin";
type Status = "new"|"accepted"|"preparing"|"ready"|"picked_up"|"on_the_way"|"delivered"|"cancelled";

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {"content-type":"application/json; charset=utf-8", ...(init.headers || {})}
  });

function id(prefix:string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function hashPassword(password:string) {
  const bytes = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

function parseCookie(req:Request, key:string) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp(`(?:^|; )${key}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export class OrderPlatformDatabase {
  state: DurableObjectState;
  sessions = new Map<string, WebSocket>();

  constructor(state:DurableObjectState) {
    this.state = state;
  }

  async init() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stores(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, logo_url TEXT, cover_url TEXT,
        description TEXT, category_id TEXT, rating REAL DEFAULT 0, reviews_count INTEGER DEFAULT 0,
        area TEXT, open INTEGER DEFAULT 1, min_order REAL DEFAULT 0, delivery_fee REAL DEFAULT 0,
        eta_minutes INTEGER DEFAULT 45, owner_user_id TEXT, active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS categories(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, image_url TEXT, sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS products(
        id TEXT PRIMARY KEY, store_id TEXT NOT NULL, category_id TEXT, name TEXT NOT NULL,
        description TEXT, price REAL NOT NULL, discount REAL DEFAULT 0, image_url TEXT,
        video_url TEXT, options_json TEXT DEFAULT '[]', available INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders(
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, store_id TEXT NOT NULL, driver_id TEXT,
        items_json TEXT NOT NULL, subtotal REAL NOT NULL, discount REAL DEFAULT 0,
        delivery_fee REAL DEFAULT 0, total REAL NOT NULL, address TEXT NOT NULL,
        phone TEXT NOT NULL, payment_method TEXT NOT NULL, notes TEXT,
        status TEXT NOT NULL, created_at TEXT NOTNULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coupons(
        id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, type TEXT NOT NULL, value REAL NOT NULL,
        min_order REAL DEFAULT 0, start_at TEXT, end_at TEXT, usage_limit INTEGER, used_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS reviews(
        id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL, customer_id TEXT NOT NULL,
        store_id TEXT NOT NULL, rating INTEGER NOT NULL, comment TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        read INTEGER DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
    `);
    const admin = this.state.storage.sql.exec(`SELECT id FROM users WHERE phone='0000000000'`).toArray();
    if (!admin.length) {
      const now = new Date().toISOString();
      const pass = await hashPassword("change-me-now");
      this.state.storage.sql.exec(
        `INSERT INTO users(id,name,phone,password_hash,role,created_at) VALUES(?,?,?,?,?,?)`,
        id("usr"), "Platform Admin", "0000000000", pass, "admin", now
      );
      const defaults = [
        ["siteName","Orderly"],
        ["currency","EGP"],
        ["primaryColor","#7c3aed"],
        ["paymentMethods",JSON.stringify(["cash_on_delivery","vodafone_cash","instapay"])]
      ];
      for (const [k,v] of defaults) this.state.storage.sql.exec(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`,k,v);
    }
  }

  async broadcast(event:unknown, userIds?:string[]) {
    const payload = JSON.stringify(event);
    for (const [uid, ws] of this.sessions) {
      if (!userIds || userIds.includes(uid)) {
        try { ws.send(payload); } catch {}
      }
    }
  }

  async fetch(req:Request) {
    await this.init();
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const uid = url.searchParams.get("userId") || "anonymous";
      server.accept();
      this.sessions.set(uid, server);
      server.addEventListener("close",()=>this.sessions.delete(uid));
      server.send(JSON.stringify({type:"connected"}));
      return new Response(null,{status:101,webSocket:client});
    }
const path = url.pathname;
    try {
      if (path === "/api/health") return json({ok:true, database:"DurableObject SQLite"});
      if (path === "/api/auth/register" && req.method==="POST") return this.register(await req.json());
      if (path === "/api/auth/login" && req.method==="POST") return this.login(await req.json());
      if (path === "/api/stores" && req.method==="GET") return this.listStores(url.searchParams);
      if (path.startsWith("/api/stores/") && req.method==="GET") return this.storeDetails(path.split("/")[3]);
      if (path === "/api/products" && req.method==="GET") return this.listProducts(url.searchParams);
      if (path === "/api/orders" && req.method==="POST") return this.createOrder(req);
      if (path === "/api/orders" && req.method==="GET") return this.listOrders(req);
      if (path.startsWith("/api/orders/") && path.endsWith("/status") && req.method==="PATCH") return this.changeOrderStatus(req,path.split("/")[3]);
      if (path.startsWith("/api/orders/") && req.method==="GET") return this.getOrder(req,path.split("/")[3]);
      if (path === "/api/categories" && req.method==="GET") return json(this.state.storage.sql.exec(`SELECT * FROM categories WHERE active=1 ORDER BY sort_order,name`).toArray());
      if (path === "/api/settings" && req.method==="GET") return this.settings();
      if (path.startsWith("/api/admin/")) return this.admin(req,path);
      return json({error:"Not found"}, {status:404});
    } catch (e) {
      return json({error:"حدث خطأ أثناء تنفيذ العملية"}, {status:500});
    }
  }

  async register(b:any) {
    if (!b?.name || !b?.phone || !b?.password) return json({error:"بيانات التسجيل غير مكتملة"},{status:400});
    const exists=this.state.storage.sql.exec(`SELECT id FROM users WHERE phone=?`,b.phone).toArray();
    if(exists.length) return json({error:"رقم الهاتف مسجل بالفعل"},{status:409});
    const uid=id("usr");
    this.state.storage.sql.exec(`INSERT INTO users(id,name,phone,password_hash,role,created_at) VALUES(?,?,?,?,?,?)`,
      uid,b.name,b.phone,await hashPassword(b.password),"customer",new Date().toISOString());
    return json({ok:true,user:{id:uid,name:b.name,role:"customer"}},{status:201});
  }

  async login(b:any) {
    const rows=this.state.storage.sql.exec(`SELECT * FROM users WHERE phone=? AND active=1`,b.phone).toArray();
    if(!rows.length || rows[0].password_hash !== await hashPassword(b.password)) return json({error:"بيانات الدخول غير صحيحة"},{status:401});
    const token=crypto.randomUUID()+"."+crypto.randomUUID();
    await this.state.storage.put(`session:${token}`,{userId:rows[0].id,role:rows[0].role});
    return new Response(JSON.stringify({ok:true,user:{id:rows[0].id,name:rows[0].name,role:rows[0].role},token}),{
      headers:{"content-type":"application/json","set-cookie":`session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`}
    });
  }

  async auth(req:Request) {
    const token=parseCookie(req,"session") || req.headersget("authorization")?.replace(/^Bearer\s+/i,"");
    if(!token) return null;
    return await this.state.storage.get<{userId:string,role:Role}>(`session:${token}`);
  }

  async listStores(sp:URLSearchParams) {
    const q=(sp.get("q")||"").trim();
    const rows=this.state.storage.sql.exec(
      `SELECT * FROM stores WHERE active=1 AND (?='' OR name LIKE '%'||?||'%' OR description LIKE '%'||?||'%') ORDER BY rating DESC LIMIT 50`,q,q,q
    ).toArray();
    return json(rows);
  }

  async storeDetails(storeId:string) {
    const store=this.state.storage.sql.exec(`SELECT * FROM stores WHERE id=?`,storeId).toArray()[0];
    if(!store) return json({error:"المتجر غير موجود"},{status:404});
    const products=this.state.storage.sql.exec(`SELECT * FROM products WHERE store_id=? AND available=1 ORDER BY name`,storeId).toArray();
    return json({store,products});
  }

  async listProducts(sp:URLSearchParams) {
    const q=(sp.get("q")||"").trim();
    const rows=this.state.storage.sql.exec(`SELECT p.*,s.name store_name FROM products p JOIN stores s ON s.id=p.store_id WHERE p.available=1 AND s.active=1 AND (?='' OR p.name LIKE '%'||?||'%' OR p.description LIKE '%'||?||'%') ORDER BY p.created_at DESC LIMIT 100`,q,q,q).toArray();
    return json(rows);
  }

  async createOrder(req:Request) {
    const a=await this.auth(req); if(!a || a.role!=="customer") return json({error:"غير مصرح"},{status:403});
    const b:any=await req.json();
    if(!b.storeId || !Array.isArray(b.items) || !b.items.length || !b.address || !b.phone) return json({error:"بيانات الطلب غير مكتملة"},{status:400});
    const store=this.state.storage.sql.exec(`SELECT * FROM stores WHERE id=? AND active=1`,b.storeId).toArray()[0];
    if(!store) return json({error:"المتجر غير متاح"},{status:400});
    const products:any[]=b.items.map((x:any)=>this.state.storage.sql.exec(`SELECT * FROM products WHERE id=? AND store_id=?`,x.productId,b.storeId).toArray()[0]).filter(Boolean);
    if(products.length!==b.items.length) return json({error:"يوجد منتج غير متاح"},{status:400});
    const items=b.items.map((x:any)=>{const p=products.find((z:any)=>z.id===x.productId); const qty=Math.max(1,Number(x.quantity)||1); const unit=Number(p.price)-Number(p.discount||0); return {productId:p.id,name:p.name,quantity:qty,unitPrice:unit,total:unit*qty};});
    const subtotal=items.reduce((s:any,x:any)=>s+x.total,0);
    if(subtotal < Number(store.min_order||0)) return json({error:`الحد الأدنى للطلب ${store.min_order}`},{status:400});
    const delivery=Number(store.delivery_fee||0);
    const orderId=id("ord"), now=new Date().toISOString();
    this.state.storage.sql.exec(`INSERT INTO orders(id,customer_id,store_id,items_json,subtotal,delivery_fee,total,address,phone,payment_method,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      orderId,a.userId,b.storeId,JSON.stringify(items),subtotal,delivery,subtotal+delivery,b.address,b.phone,b.paymentMethod||"cash_on_delivery",b.notes||"", "new",now,now);
    await this.notify(a.userId,"تم إنشاء الطلب","تم استلام طلبك بنجاح");
    await this.broadcast({type:"order.created",orderId,status:"new"},[a.userId]);
    return json({ok:true,orderId},{status:201});
  }

  async listOrders(req:Request) {
    const a=await this.auth(req); if(!a) return json({error:"غير مصرح"},{status:403});
    let sql=`SELECT * FROM orders`; const args:any[]=[];
    if(a.role==="customer"){sql+=` WHERE customer_id=?`;args.push(a.userId);}
    else if(a.role==="store"){sql+=` WHERE store_id=(SELECT id FROM stores WHERE owner_user_id=?)`;args.push(a.userId);}
    else if(a.role==="driver"){sql+=` WHERE driver_id=?`;args.push(a.userId);}
    sql+=` ORDER BY created_at DESC LIMIT 100`;
    return json(this.state.storage.sql.exec(sql,...args).toArray());
  }

  async getOrder(req:Request,orderId:string) {
    const a=await this.auth(req); if(!a) return json({error:"غير مصرح"},{status:403});
    const o=this.state.storage.sql.exec(`SELECT * FROM orders WHERE id=?`,orderId).toArray()[0];
    if(!o) return json({error:"الطلب غير موجود"},{status:404});
    if(a.role==="customer" && o.customer_id!==a.userId) return json({error:"غير مصرح"},{status:403});
    if(a.role==="driver" && o.driver_id!==a.userId) return json({error:"غير مصرح"},{status:403});
    if(a.role==="store"){
      const own=this.state.storage.sql.exec(`SELECT id FROM stores WHERE id=? AND owner_user_id=?`,o.store_id,a.userId).toArray();
      if(!own.length)return json({error:"غير مصرح"},{status:403});
    }
    return json({...o,items:JSON.parse(o.items_json)});
  }

  async changeOrderStatus(req:Request,orderId:string) {
    const a=await this.auth(req); if(!a || !["store","driver","admin"].includes(a.role)) return json({error:"غير مصرح"},{status:403});
    const b:any=await req.json();
    const allowed:Status[]=["new","accepted","preparing","ready","picked_up","on_the_way","delivered","cancelled"];
    if(!allowed.includes(b.status)) return json({error:"حالة غير صالحة"},{status:400});
    const o=this.state.storage.sql.exec(`SELECT * FROM orders WHERE id=?`,orderId).toArray()[0];
    if(!o)return json({error:"الطلب غير موجود"},{status:404});
    if(a.role==="store"){
      const own=this.state.storage.sql.exec(`SELECT id FROM stores WHERE id=? AND owner_user_id=?`,o.store_id,a.userId).toArray();
      if(!own.length)return json({error:"غير مصرح"},{status:403});
    }
    if(a.role==="driver" && o.driver_id!==a.userId)return json({error:"غير مصرح"},{status:403});
    const now=new Date().toISOString();
    this.state.storage.sql.exec(`UPDATE orders SET status=?,updated_at=? WHERE id=?`,b.status,now,orderId);
    await this.notify(o.customer_id,"تحديث الطلب",`حالة طلبك الآن: ${b.status}`);
    await this.broadcast({type:"order.updated",orderId,status:b.status},[o.customer_id,o.driver_id].filter(Boolean));
    return json({ok:true,status:b.status});
  }

  async notify(userId:string,title:string,body:string){
    this.state.storage.sql.exec(`INSERT INTO notifications(id,user_id,title,body,created_at) VALUES(?,?,?,?,?)`,id("ntf"),userId,title,body,new Date().toISOString());
  }

  async settings(){
    const rows=this.state.storage.sql.exec(`SELECT key,value FROM settings`).toArray();
    return json(Object.fromEntries(rows.map((x:any)=>[x.key, (()=>{try{return JSON.parse(x.value)}catch{return x.value}})()])));
  }

  async admin(req:Request,path:string) {
    const a=await this.auth(req); if(!a || a.role!=="admin") return json({error:"غير مصرح"},{status:403});
    if(path==="/api/admin/summary" && req.method==="GET"){
      const count=(t:string)=>this.state.storage.sql.exec(`SELECT COUNT(*) n FROM ${t}`).toArray()[0].n;
      const sales=this.state.storage.sql.exec(`SELECT COALESCE(SUM(total),0) n FROM orders WHERE status='delivered'`).toArray()[0].n;
      return json({customers:this.state.storage.sql.exec(`SELECT COUNT(*) n FROM users WHERE role='customer'`).toArray()[0].n,stores:count("stores"),products:count("products"),drivers:this.state.storage.sql.exec(`SELECT COUNT(*) n FROM users WHERE role='driver'`).toArray()[0].n,orders:count("orders"),sales});
    }
    if(path==="/api/admin/categories" && req.method==="POST"){
      const b:any=await req.json(); if(!b.name)return json({error:"الاسم مطلوب"},{status:400});
      const cid=id("cat");this.state.storage.sql.exec(`INSERT INTO categories(id,name,image_url,sort_order) VALUES(?,?,?,?)`,cid,b.name,b.imageUrl||"",Number(b.sortOrder||0));return json({ok:true,id:cid},{status:201});
    }
    if(path==="/api/admin/stores" && req.method==="POST"){
      const b:any=await req.json();const sid=id("store");this.state.storage.sql.exec(`INSERT INTO stores(id,name,logo_url,cover_url,description,category_id,area,min_order,delivery_fee,eta_minutes,owner_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,sid,b.name,b.logoUrl||"",b.coverUrl||"",b.description||"",b.categoryId||"",b.area||"",Number(b.minOrder||0),Number(b.deliveryFee||0),Number(b.etaMinutes||45),b.ownerUserId||null,new Date().toISOString());return json({ok:true,id:sid},{status:201});
    }
    return json({error:"Admin endpoint not implemented"},{status:404});
  }
}

export default {
  async fetch(req:Request, env:Env, ctx:ExecutionContext) {
    const url=new URL(req.url);
    if(url.pathname.startsWith("/api/")){
      const stub=env.ORDER_PLATFORM_DATABASE.get(env.ORDER_PLATFORM_DATABASE.idFromName("main"));
      return stub.fetch(req);
    }
return env.ASSETS.fetch(req);
  }
};
