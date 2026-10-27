# SadakatKarti — QR sadiqlik kartı (çox şirkətli) ☕

Müştəri telefonunda QR kartı saxlayır, kassada skan olunur, N möhürdən sonra hədiyyə. Hər şirkətin öz paneli var,
ümumi admin panel isə bütün şirkətləri, kartları və logları canlı göstərir. Hesabatım-a bağlı şirkətlərin kartları
həm Hesabatım-ın **Müştərilər** bölməsində, həm də SadakatKarti-nin öz bazasında görünür.

**Texnologiya:** React 18 + TypeScript + Vite, Node.js 22 (`http`, canlı yeniləmə SSE ilə), Postgres (`pg`; lokalda PGlite).
Sistem dizaynı: https://claude.ai/artifact/4Zmh1jjgZgH6H7574B4dpB · Canlı: https://sadakatkarti-production.up.railway.app

## Səhifələr

| Ünvan | Kim üçün |
|---|---|
| `/k/<slug>` | Müştəri qeydiyyatı (kassada QR plakat kimi asılır). `/` — `DEFAULT_COMPANY` və ya yeganə şirkət |
| `/c/<token>` | Müştərinin kartı və QR kodu — möhür vurulan, rəng və ya loqo dəyişən an SSE ilə yenilənir |
| `/panel` | Şirkət paneli: kassa (QR skan, möhür, hədiyyə), müştərilər, 14 günlük qrafiklər, canlı axın, öz logları, ayarlar |
| `/admin` | Ümumi admin: dashboard, şirkətlər (yarat/düzəlt/bağla), bütün kartlar, loglar (filtr, canlı, CSV), sistem/inteqrasiya vəziyyəti. **Yalnız `ADMIN_ALLOWED_IPS`-dən açılır**, başqa IP-yə 404 |

## İşə salmaq

```
npm install
npm run dev     # http://localhost:5173 (API 3000-də). DATABASE_URL yoxdursa data/pglite istifadə olunur
npm run build && npm start
```

Lokal admin üçün: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_ALLOWED_IPS=127.0.0.1,::1`.

## Mühit dəyişənləri

| Dəyişən | Mənası |
|---|---|
| `DATABASE_URL` | Postgres (Railway: `${{Postgres-i46k.DATABASE_URL}}`). Boşdursa PGlite (`PGLITE_DIR`, standart `data/pglite`) |
| `SESSION_SECRET` | Sessiya cookie-lərinin imza açarı (≥32 simvol). Verilməsə hər restartda hamı çıxış edir |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Ümumi admin girişi |
| `ADMIN_ALLOWED_IPS` | Vergüllə IP siyahısı. Boşdursa admin panel tam bağlıdır |
| `CLIENT_IP_HEADER` | Müştəri IP-si hansı başlıqdan oxunsun: Railway üçün `x-real-ip` (standart), Cloudflare qoyulsa `cf-connecting-ip` |
| `TRUST_PROXY` | `1` — proxy başlığına inan (Railway-də avtomatik) |
| `DEFAULT_COMPANY` | `/` ünvanının şirkət slug-u |
| `COOLDOWN_SEC` | Eyni karta təkrar möhürdən qoruma (standart 30) |
| `TIMEZONE` | Statistika günləri (standart `Asia/Baku`) |
| `LOG_RETENTION_DAYS` | Loglar neçə gün saxlanır (standart 30) |
| `HESABATIM_API_URL` | Hesabatım API, məs. `http://backend.railway.internal:8000/api/v1` (Railway şəxsi şəbəkəsi) |
| `HESABATIM_PROXY_SECRET` | Hesabatım-ın `PROXY_SECRET`-i (`${{backend.PROXY_SECRET}}`) — limitlər müştərinin öz IP-sinə tətbiq olunur |
| `HESABATIM_WEBHOOK_SECRET` | Hesabatım-ın `SADAKAT_WEBHOOK_SECRET`-i ilə eyni (≥32 simvol) |
| `SYNC_INTERVAL_SEC` | Webhook-dan əlavə fon sinxronizasiyası (standart 15, `0` = söndür) |
| `HESABATIM_BUSINESS` | Köhnə quraşdırma: baza boşdursa bu slug ilə Hesabatım-a bağlı şirkət avtomatik yaranır |

## Hesabatım inteqrasiyası

- Admin paneldə şirkət yaradarkən **Hesabatım biznes slug-u** yazılırsa, şirkət "bağlı" olur: kart Hesabatım-ın
  `POST /public/businesses/{slug}/cards` ilə yaranır (`customers` cədvəlində), güzgüsü SadakatKarti bazasına yazılır.
- Möhür/hədiyyə Hesabatım-da vurulur (Müştərilər → Kartı oxut). Hesabatım imzalı webhook göndərir
  (`POST /api/integrations/hesabatim/webhook`, `X-Sadakat-Signature: sha256=HMAC(secret, "<ts>.<body>")`),
  SadakatKarti güzgünü yeniləyir və SSE (`GET /api/live`) ilə müştəriyə, şirkət panelinə və adminə ötürür.
  Webhook çatmasa, ekranda açıq kartlar hər `SYNC_INTERVAL_SEC` saniyədə Hesabatım-dan yoxlanır.
- Brauzer Hesabatım-a heç vaxt birbaşa getmir — bütün sorğular bu serverdən proxy olunur.
- Bağlı olmayan (müstəqil) şirkətlər möhürü birbaşa `/panel`-də vurur.

## Loglar

Hər API sorğusu (metod, yol — kart tokeni maskalanır, status, müddət, IP, user-agent), giriş cəhdləri, IP rəddləri,
CSRF blokları, möhür/hədiyyə, şirkət dəyişiklikləri, webhook və sinxronizasiya hadisələri `logs` cədvəlinə yazılır,
admin panelə SSE ilə canlı gəlir və Railway loglarında JSON sətir kimi görünür. Şirkət yalnız öz
əməliyyat/təhlükəsizlik loglarını görür.

## Railway

`railway.json` hazırdır (Railpack, `npm run build`, `npm start`, `/health`). Postgres xidməti əlavə edib
`DATABASE_URL`-i ona bağlayın. Kamera üçün HTTPS lazımdır — Railway domeni bunu verir.
