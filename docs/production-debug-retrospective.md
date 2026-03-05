# 📋 Rút kinh nghiệm: Debug Production BugBot System
> Ngày: 04–05/03/2026 | Hệ thống: IoT Camera BugBot

---

## 1. Tất cả domain bị 502 Bad Gateway (Cloudflare)

### Triệu chứng
- Tất cả các domain (`bugbot`, `kafka`, `minio`, `label`, `ai`, `clickhouse`) đều báo **502 Bad Gateway** từ Cloudflare.

### Nguyên nhân gốc rễ
Khi chạy `docker compose up` và gặp lỗi giữa chừng (backend `unhealthy`), Docker **xóa và tạo lại toàn bộ internal network** (`iot_network`). Điều này làm **cloudflared tunnel mất kết nối** vì các container đã thay đổi IP nội bộ.

### Giải pháp
```bash
# 1. Fix nguyên nhân khiến backend unhealthy, rồi up lại
docker compose -f docker-compose.prod.yml --env-file .env up -d

# 2. Restart cloudflared để nhận kết nối mới
sudo systemctl restart cloudflared
```

### Bài học
> Sau mỗi lần `docker compose up` mà có container fail hoặc network bị recreate,
> **luôn restart cloudflared** để tunnel reconnect lại với IP mới của containers.

---

## 2. Backend container bị Docker đánh dấu `unhealthy`

### Triệu chứng
```
bugbot-backend  Error  dependency failed to start: container is unhealthy
```

### Nguyên nhân gốc rễ
Backend kết nối vào MinIO bằng **SSL** (`MINIO_USE_SSL=true`), nhưng MinIO chạy trong Docker không dùng SSL nội bộ → lỗi SSL handshake → health check thất bại.

### Giải pháp
Đặt trong file `.env` trên server:
```env
MINIO_USE_SSL=false
```

### Bài học
> **Phân biệt rõ hai loại SSL:**
> - SSL **nội bộ** Docker (container-to-container): luôn `false` trừ khi cấu hình riêng
> - SSL **bên ngoài** (Cloudflare, Nginx): do Cloudflare/Nginx xử lý, backend không cần biết

---

## 3. Nginx configs cho service phụ trỏ sai port

### Triệu chứng
- `minio.nguyentrungnam.com`, `label.nguyentrungnam.com`... báo lỗi hoặc không load được.

### Nguyên nhân gốc rễ
Các file nginx config (`minio.conf`, `label.conf`, `kafka.conf`...) dùng port placeholder (1440, 1441...) nhưng `docker-compose.prod.yml` lại không map các container ra đúng các port đó.

| Service | Port Nginx chờ | Port Docker cũ | Port Docker đúng |
|---|---|---|---|
| MinIO Console | 1441 | 9001 (9001:9001) | **1441:9001** |
| Label Studio | 1447 | 8082 (8082:8080) | **1447:8080** |
| ClickHouse HTTP | 1443 | 8123 (8123:8123) | **1443:8123** |
| AI Inference | 1446 | 8000 (8000:8000) | **1446:8000** |
| Redpanda Console | 1440 | ❌ không có | **thêm service mới** |

### Giải pháp
Cập nhật port mapping trong `docker-compose.prod.yml` để khớp với Nginx:
```yaml
minio:
  ports:
    - "1441:9001"   # Console UI → Nginx chờ port này
label-studio:
  ports:
    - "1447:8080"   # UI → Nginx chờ port này
```

Và **thêm service** Redpanda Console (bị thiếu trong prod):
```yaml
redpanda-console:
  image: docker.redpanda.com/redpandadata/console:v2.4.5
  ports:
    - "1440:8080"
```

### Bài học
> Khi dùng Cloudflare Tunnel + Nginx reverse proxy, **port phải đi theo hướng**:  
> `Cloudflare → Nginx (80) → [proxy_pass localhost:PORT] → Docker (PORT:containerPort)`  
> Docker phải expose đúng PORT ra host mà Nginx đang chờ.

---

## 4. Label Studio lỗi CSRF 403 khi login qua Cloudflare

### Triệu chứng
```
Forbidden (403)
CSRF verification failed. Request aborted.
```

### Nguyên nhân gốc rễ
Label Studio dùng Django, framework này kiểm tra `Referer` header khi POST login form. Khi đi qua Cloudflare Tunnel + Nginx, request origin là `https://label.nguyentrungnam.com` nhưng không nằm trong `CSRF_TRUSTED_ORIGINS`.

### Giải pháp
Thêm vào `docker-compose.prod.yml` cho service `label-studio`:
```yaml
environment:
  - LABEL_STUDIO_HOST=https://label.nguyentrungnam.com
  - CSRF_TRUSTED_ORIGINS=https://label.nguyentrungnam.com
```

### Bài học
> Mọi app dùng Django/Rails/Laravel phía sau reverse proxy đều **phải** khai báo `CSRF_TRUSTED_ORIGINS` hoặc tương đương.  
> Khi deploy qua Cloudflare Tunnel, origin trong mắt app luôn là domain công khai (https).

---

## 5. Frontend gọi API sai URL (thiếu prefix `/api/`)

### Triệu chứng
```
GET https://bugbot.nguyentrungnam.com/cam/images  →  404 Not Found
```

### Nguyên nhân gốc rễ
Trong `frontend/src/services/api.js`, một số endpoint bị thiếu prefix `/api/`:
```js
// SAI
getImages: () => api.get('/cam/images')
// ĐÚNG
getImages: () => api.get('/api/cam/images')
```

### Giải pháp
Kiểm tra tất cả endpoint trong `api.js` và đảm bảo có prefix `/api/` đúng với cấu hình Nginx `proxy_pass`.

### Bài học
> Luôn tập trung URL prefix vào **một constant duy nhất** (`API_BASE_URL`) thay vì hardcode từng endpoint.  
> Với React: dùng `REACT_APP_API_BASE_URL` hoặc config tập trung để tránh lỗi typo.

---

## 6. Ảnh hiển thị lỗi vì MinIO internal URL bị trả về frontend

### Triệu chứng
```
GET http://localhost:9000/iot-raw/raw/...jpg  →  net::ERR_CONNECTION_REFUSED
```

### Nguyên nhân gốc rễ (từng lớp)

**Lớp 1**: Hàm `getPublicObjectUrl()` trong `minio.js` tạo URL theo format MinIO Console API:
```
http://minio.nguyentrungnam.com/api/v1/buckets/iot-raw/objects/download?prefix=<base64>&version_id=null
```
URL này được lưu vào ClickHouse làm `image_url`.

**Lớp 2**: Hàm `transformInternalUrlToPublic()` dùng `MINIO_PUBLIC_ENDPOINT=localhost` làm fallback → URL bị chuyển thành `http://localhost:9000/...` → trình duyệt không truy cập được.

### Giải pháp
Thêm backend endpoint **proxy ảnh** từ MinIO về client:
```
GET /api/cam/images/:id/serve
```
Backend tự fetch ảnh từ MinIO (internal network) và stream về browser. Client không cần truy cập MinIO trực tiếp.

Quan trọng: khi parse `objectKey` từ URL MinIO Console format, phải **decode base64** từ query param `prefix`:
```js
const prefix = searchParams.get('prefix');
if (prefix && pathname.includes('/api/v1/buckets/')) {
    objectKey = Buffer.from(prefix, 'base64').toString('utf8');
}
```

### Bài học
> **Không lưu URL phụ thuộc vào domain/internal address vào database.**  
> Thay vào đó, lưu **objectKey thuần** (`raw/2026/03/05/cam-xxx/file.jpg`) rồi tính URL khi cần.  
>
> **Pattern chuẩn:**
> ```
> DB lưu: objectKey = "raw/2026/03/05/cam-xxx/file.jpg"
> Khi trả API: tính URL từ objectKey theo môi trường (dev/prod)
> ```

---

## 7. Rate Limit 429 Too Many Requests

### Triệu chứng
Frontend liên tục bắn request bị chặn 429.

### Nguyên nhân gốc rễ
- `.env` trên server đặt `RATE_LIMIT_MAX_REQUESTS=100` / 15 phút — quá thấp
- SSE stream `/events/stream` cũng bị tính vào rate limit dù chỉ là 1 kết nối

### Giải pháp
1. Tăng rate limit trong `.env`:
```env
RATE_LIMIT_WINDOW_MS=300000
RATE_LIMIT_MAX_REQUESTS=2000
```
2. Exclude SSE endpoint khỏi rate limiter trong `app.js`:
```js
skip: (req) => req.path === '/api/iot/mqtt/events/stream'
```

### Bài học
> **Long-lived connections (SSE, WebSocket) phải được exclude khỏi rate limiter.**  
> Rate limit chỉ nên áp dụng cho các request ngắn (REST API), không phải kết nối streaming.

---

## Tổng kết: Checklist khi deploy production

- [ ] Docker network: sau khi `up` thất bại → restart `cloudflared`
- [ ] MinIO: `MINIO_USE_SSL=false` trong môi trường Docker nội bộ
- [ ] Nginx port mapping: Docker expose đúng port mà Nginx proxy_pass trỏ đến
- [ ] CSRF: thêm `CSRF_TRUSTED_ORIGINS` cho app Django/Rails phía sau reverse proxy
- [ ] Frontend API URL: kiểm tra tất cả endpoint có đúng prefix
- [ ] Object Storage: lưu `objectKey` thuần vào DB, không lưu URL có domain
- [ ] Rate Limit: exclude SSE/WebSocket khỏi rate limiter
