const $ = (s) => document.querySelector(s);

let cart = JSON.parse(localStorage.getItem("cart") || "[]");
let token = localStorage.getItem("token") || null;

const api = async (path, opt = {}) => {
  const headers = {
    "content-type": "application/json",
    ...(opt.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const r = await fetch(path, {
    ...opt,
    headers,
    credentials: "same-origin"
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(d.error || "حدث خطأ");
  }

  return d;
};

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[m]
  );
}

function img(url, alt = "") {
  return url
    ? `<img loading="lazy" src="${esc(url)}" alt="${esc(
        alt
      )}" onerror="this.style.display='none'">`
    : `<span style="font-size:38px">◈</span>`;
}

/* =========================
   LOAD HOME DATA
========================= */

async function load() {
  try {
    const [cats, stores, products, settings] = await Promise.all([
      api("/api/categories"),
      api("/api/stores"),
      api("/api/products"),
      api("/api/settings")
    ]);

    if ($("#brandName")) {
      $("#brandName").textContent = settings.siteName || "Orderly";
    }

    renderCats(cats);
    renderStores(stores);
    renderProducts(products);
  } catch (e) {
    console.error("Load error:", e);
  }

  updateCart();
}

/* =========================
   CATEGORIES
========================= */

function renderCats(a) {
  const el = $("#categories");
  if (!el) return;

  el.innerHTML = a.length
    ? a
        .map(
          (x) =>
            `<button class="chip" onclick="filterCat('${esc(
              x.id
            )}')">${esc(x.name)}</button>`
        )
        .join("")
    : `<span class="muted">لا توجد تصنيفات بعد.</span>`;
}

function filterCat(id) {
  const products = document.querySelector("#products");
  if (products) {
    products.scrollIntoView({ behavior: "smooth" });
  }

  api("/api/products?categoryId=" + encodeURIComponent(id))
    .then(renderProducts)
    .catch((e) => toast(e.message, true));
}

/* =========================
   STORES
========================= */

function renderStores(a) {
  const el = $("#stores");
  if (!el) return;

  el.innerHTML = a.length
    ? a
        .map(
          (s) => `
          <article class="card" onclick="openStore('${esc(s.id)}')">
            <div class="visual">
              ${img(s.cover_url || s.logo_url, s.name)}
            </div>

            <div class="cardBody">
              <h3>${esc(s.name)}</h3>

              <div class="muted">
                ${esc(s.area || "")}
                •
                ${s.open ? "مفتوح" : "مغلق"}
                •
                ${s.eta_minutes || 45} دقيقة
              </div>

              <div class="price">
                التوصيل ${Number(s.delivery_fee || 0).toFixed(2)} ج.م
              </div>
            </div>
          </article>
        `
        )
        .join("")
    : `<div class="muted">لا توجد متاجر حتى الآن.</div>`;
}

async function loadStores() {
  try {
    const stores = await api("/api/stores");
    renderStores(stores);

    $("#stores")?.scrollIntoView({
      behavior: "smooth"
    });
  } catch (e) {
    toast(e.message, true);
  }
}

/* =========================
   PRODUCTS
========================= */

function renderProducts(a) {
  const el = $("#products");
  if (!el) return;

  el.innerHTML = a.length
    ? a
        .map((p) => {
          const price =
            Number(p.price || 0) - Number(p.discount || 0);

          return `
            <article
              class="card"
              onclick="add(
                '${esc(p.id)}',
                '${esc(p.store_id)}',
                '${esc(p.name)}',
                ${price}
              )"
            >
              <div class="visual">
                ${img(p.image_url, p.name)}
              </div>

              <div class="cardBody">
                <h3>${esc(p.name)}</h3>

                <div class="muted">
                  ${esc(p.store_name || "")}
                </div>

                <div class="price">
                  ${price.toFixed(2)} ج.م
                </div>
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="muted">لا توجد منتجات حتى الآن.</div>`;
}

/* =========================
   STORE DETAILS
========================= */

async function openStore(id) {
  try {
    const d = await api("/api/stores/" + encodeURIComponent(id));

    $("#modalContent").innerHTML = `
      <span class="eyebrow">
        ${esc(d.store.area || "")}
      </span>

      <h2>${esc(d.store.name)}</h2>

      <p class="muted">
        ${esc(d.store.description || "")}
      </p>

      <div class="grid products">
        ${
          d.products.length
            ? d.products
                .map((p) => {
                  const price =
                    Number(p.price || 0) -
                    Number(p.discount || 0);

                  return `
                    <article
                      class="card"
                      onclick="add(
                        '${esc(p.id)}',
                        '${esc(d.store.id)}',
                        '${esc(p.name)}',
                        ${price}
                      )"
                    >
                      <div class="visual">
                        ${img(p.image_url, p.name)}
                      </div>

                      <div class="cardBody">
                        <h3>${esc(p.name)}</h3>

                        <div class="price">
                          ${price.toFixed(2)} ج.م
                        </div>
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `<div class="muted">لا توجد منتجات.</div>`
        }
      </div>
    `;

    openModal();
  } catch (e) {
    toast(e.message, true);
  }
}

/* =========================
   CART
========================= */

function add(pid, sid, name, price) {
  if (cart.length && cart[0].storeId !== sid) {
    if (
      !confirm(
        "لديك منتجات من متجر آخر. هل تريد إفراغ السلة والبدء من المتجر الجديد؟"
      )
    ) {
      return;
    }

    cart = [];
  }

  const x = cart.find((x) => x.productId === pid);

  if (x) {
    x.quantity++;
  } else {
    cart.push({
      productId: pid,
      storeId: sid,
      name,
      price,
      quantity: 1
    });
  }

  saveCart();

  toast("تمت إضافة المنتج للسلة");
}

function saveCart() {
  localStorage.setItem("cart", JSON.stringify(cart));
  updateCart();
}

function updateCart() {
  const count = cart.reduce(
    (sum, x) => sum + Number(x.quantity || 0),
    0
  );

  if ($("#cartCount")) {
    $("#cartCount").textContent = count;
  }
}

function openCart() {
  const total = cart.reduce(
    (sum, x) =>
      sum + Number(x.price || 0) * Number(x.quantity || 0),
    0
  );

  $("#modalContent").innerHTML = `
    <h2>السلة</h2>

    ${
      cart.length
        ? `
          ${cart
            .map(
              (x) => `
                <div
                  style="
                    display:flex;
                    justify-content:space-between;
                    align-items:center;
                    gap:10px;
                    padding:12px 0;
                    border-bottom:1px solid var(--line)
                  "
                >
                  <span>
                    ${esc(x.name)} × ${x.quantity}
                  </span>

                  <b>
                    ${(
                      Number(x.price) * Number(x.quantity)
                    ).toFixed(2)}
                    ج.م
                  </b>
                </div>
              `
            )
            .join("")}

          <h3>
            الإجمالي:
            ${total.toFixed(2)} ج.م
          </h3>

          <button class="primary" onclick="checkout()">
            إتمام الطلب
          </button>

          <button
            class="ghost"
            onclick="clearCart()"
            style="margin-top:10px"
          >
            إفراغ السلة
          </button>
        `
        : `
          <div style="padding:35px;text-align:center">
            <h3>السلة فارغة</h3>
            <p class="muted">
              أضف منتجات من أحد المتاجر.
            </p>
          </div>
        `
    }
  `;

  openModal();
}

function clearCart() {
  if (!cart.length) return;

  if (confirm("هل تريد إفراغ السلة؟")) {
    cart = [];
    saveCart();
    openCart();
  }
}

/* =========================
   CHECKOUT
========================= */

function checkout() {
  if (!cart.length) {
    toast("السلة فارغة", true);
    return;
  }

  if (!token) {
    openLogin();
    return;
  }

  $("#modalContent").innerHTML = `
    <h2>إتمام الطلب</h2>

    <label>العنوان</label>
    <input
      id="addr"
      class="field"
      placeholder="العنوان بالتفصيل"
    >

    <label>رقم الهاتف</label>
    <input
      id="phone"
      class="field"
      placeholder="01xxxxxxxxx"
    >

    <label>طريقة الدفع</label>

    <select id="pay" class="field">
      <option value="cash_on_delivery">
        الدفع عند الاستلام
      </option>

      <option value="vodafone_cash">
        Vodafone Cash
      </option>

      <option value="instapay">
        Instapay
      </option>
    </select>

    <button
      class="primary"
      onclick="placeOrder()"
    >
      تأكيد الطلب
    </button>
  `;
}

/* =========================
   CREATE ORDER
========================= */

async function placeOrder() {
  try {
    const address = $("#addr")?.value.trim();
    const phone = $("#phone")?.value.trim();
    const paymentMethod = $("#pay")?.value;

    if (!address || !phone) {
      toast("اكتب العنوان ورقم الهاتف", true);
      return;
    }

    const d = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        storeId: cart[0].storeId,
        items: cart,
        address,
        phone,
        paymentMethod
      })
    });

    cart = [];
    saveCart();

    $("#modalContent").innerHTML = `
      <h2>تم إنشاء طلبك ✓</h2>

      <p>
        رقم الطلب:
        <b>${esc(d.orderId)}</b>
      </p>

      <p class="muted">
        تم إرسال طلبك بنجاح ويمكنك متابعة حالته.
      </p>

      <button
        class="primary"
        onclick="closeModal()"
      >
        إغلاق
      </button>
    `;
  } catch (e) {
    toast(e.message, true);
  }
}

/* =========================
   LOGIN
========================= */

function openLogin() {
  $("#modalContent").innerHTML = `
    <h2>تسجيل الدخول</h2>

    <input
      id="loginPhone"
      class="field"
      placeholder="رقم الهاتف"
      inputmode="tel"
    >

    <input
      id="loginPass"
      type="password"
      class="field"
      placeholder="كلمة المرور"
    >

    <button
      class="primary"
      onclick="login()"
    >
      دخول
    </button>

    <hr>

    <h3>إنشاء حساب</h3>

    <input
      id="regName"
      class="field"
      placeholder="الاسم"
    >

    <input
      id="regPhone"
      class="field"
      placeholder="رقم الهاتف"
      inputmode="tel"
    >

    <input
      id="regPass"
      type="password"
      class="field"
      placeholder="كلمة المرور"
    >

    <button
      class="ghost"
      onclick="register()"
    >
      إنشاء حساب
    </button>
  `;

  openModal();
}

/* =========================
   LOGIN REQUEST
========================= */

async function login() {
  try {
    const phone = $("#loginPhone").value.trim();
    const password = $("#loginPass").value;

    if (!phone || !password) {
      toast("اكتب رقم الهاتف وكلمة المرور", true);
      return;
    }

    const d = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        phone,
        password
      })
    });

    token = d.token;

    localStorage.setItem("token", token);

    toast("تم تسجيل الدخول بنجاح");

    closeModal();

    updateAccountButton(d.user);
  } catch (e) {
    toast(e.message, true);
  }
}

/* =========================
   REGISTER
========================= */

async function register() {
  try {
    const name = $("#regName").value.trim();
    const phone = $("#regPhone").value.trim();
    const password = $("#regPass").value;

    if (!name || !phone || !password) {
      toast("أكمل بيانات التسجيل", true);
      return;
    }

    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name,
        phone,
        password
      })
    });

    toast("تم إنشاء الحساب. سجّل الدخول الآن");

    $("#loginPhone").value = phone;
    $("#loginPass").value = "";

  } catch (e) {
    toast(e.message, true);
  }
}

/* =========================
   LOGOUT
========================= */

function logout() {
  token = null;
  localStorage.removeItem("token");

  toast("تم تسجيل الخروج");

  if ($("#loginBtn")) {
    $("#loginBtn").textContent = "تسجيل الدخول";
  }
}

function updateAccountButton(user) {
  if (!$("#loginBtn")) return;

  $("#loginBtn").textContent =
    user?.name
      ? `مرحبًا ${user.name}`
      : "حسابي";
}

/* =========================
   MODAL
========================= */

function openModal() {
  $("#modal")?.classList.remove("hidden");
}

function closeModal() {
  $("#modal")?.classList.add("hidden");
}

/* =========================
   TOAST
========================= */

function toast(message, err = false) {
  const x = document.createElement("div");

  x.textContent = message;

  x.style.cssText = `
    position:fixed;
    bottom:85px;
    right:18px;
    background:${err ? "#b42318" : "#1f1a25"};
    color:#fff;
    padding:13px 17px;
    border-radius:13px;
    z-index:9999;
    font-weight:700;
    box-shadow:0 10px 30px rgba(0,0,0,.18);
  `;

  document.body.appendChild(x);

  setTimeout(() => x.remove(), 2600);
}

/* =========================
   SEARCH
========================= */

function doSearch() {
  const q = $("#heroSearch")?.value || "";

  if ($("#search")) {
    $("#search").value = q;
  }

  search(q);
}

async function search(q) {
  try {
    const p = await api(
      "/api/products?q=" + encodeURIComponent(q)
    );

    renderProducts(p);

    $("#products")?.scrollIntoView({
      behavior: "smooth"
    });
  } catch (e) {
    toast(e.message, true);
  }
}

/* =========================
   EVENTS
========================= */

document.addEventListener("DOMContentLoaded", () => {
  $("#cartBtn")?.addEventListener("click", openCart);

  $("#loginBtn")?.addEventListener("click", openLogin);

  $("#search")?.addEventListener("input", (e) => {
    clearTimeout(window.searchTimer);

    window.searchTimer = setTimeout(() => {
      search(e.target.value);
    }, 300);
  });

  $("#modal")?.addEventListener("click", (e) => {
    if (e.target.id === "modal") {
      closeModal();
    }
  });

  load();
});
