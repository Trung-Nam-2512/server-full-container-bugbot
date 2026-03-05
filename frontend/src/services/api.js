import axios from 'axios';
import { API_CONFIG } from '../utils/constants';

const api = axios.create({
    baseURL: API_CONFIG.BASE_URL,
    timeout: API_CONFIG.TIMEOUT,
});

// ── Error formatting ────────────────────────────────────────────

const getErrorMessage = (error) => {
    if (!error.response) {
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            return { title: 'Hết thời gian chờ', message: 'Yêu cầu mất quá nhiều thời gian. Vui lòng thử lại.', type: 'timeout' };
        }
        if (error.message === 'Network Error') {
            return { title: 'Lỗi kết nối', message: 'Không thể kết nối đến server.', type: 'network' };
        }
        return { title: 'Lỗi không xác định', message: error.message || 'Đã xảy ra lỗi.', type: 'unknown' };
    }

    const { status, data } = error.response;
    const serverMessage = data?.error || data?.message || 'Đã xảy ra lỗi';

    const messages = {
        400: { title: 'Yêu cầu không hợp lệ', type: 'bad_request' },
        401: { title: 'Không có quyền truy cập', type: 'unauthorized' },
        403: { title: 'Bị từ chối truy cập', type: 'forbidden' },
        404: { title: 'Không tìm thấy', type: 'not_found' },
        500: { title: 'Lỗi server', type: 'server_error' },
        502: { title: 'Server không khả dụng', type: 'server_unavailable' },
        503: { title: 'Server không khả dụng', type: 'server_unavailable' },
        504: { title: 'Server không khả dụng', type: 'server_unavailable' },
    };

    const info = messages[status] || { title: `Lỗi ${status}`, type: 'http_error' };
    return { ...info, message: serverMessage };
};

// ── Interceptors ────────────────────────────────────────────────

api.interceptors.request.use(
    (config) => {
        config.metadata = { startTime: new Date() };
        if (process.env.NODE_ENV === 'development') {
            const fullUrl = config.baseURL ? `${config.baseURL}${config.url}` : config.url;
            console.log(`[API] ${config.method?.toUpperCase()} ${fullUrl}`);
        }
        return config;
    },
    (error) => Promise.reject(error)
);

api.interceptors.response.use(
    (response) => {
        if (response.config.metadata && process.env.NODE_ENV === 'development') {
            const duration = new Date() - response.config.metadata.startTime;
            console.log(`[API] ${response.config.method?.toUpperCase()} ${response.config.url} - ${duration}ms`);
        }
        return response;
    },
    (error) => {
        error.errorInfo = getErrorMessage(error);
        if (process.env.NODE_ENV === 'development') {
            console.error('[API Error]', {
                url: error.config?.url,
                status: error.response?.status,
                message: error.errorInfo.message,
            });
        }
        return Promise.reject(error);
    }
);

// ── API Endpoints ───────────────────────────────────────────────

export const apiService = {
    // MQTT connection status
    getMqttStatus: () => api.get('/api/iot/mqtt/status'),

    // Device management (new registry-based)
    getDevices: () => api.get('/api/iot/mqtt/devices'),
    getDeviceDetail: (deviceId) => api.get(`/api/iot/mqtt/devices/${deviceId}`),
    getDeviceStatus: (deviceId) => api.get(`/api/iot/mqtt/devices/${deviceId}/status`),
    deleteDevice: (deviceId) => api.delete(`/api/iot/mqtt/devices/${deviceId}`),

    // Device commands
    capturePhoto: (deviceId) => api.post(`/api/iot/mqtt/devices/${deviceId}/capture`),
    requestStatus: (deviceId) => api.post(`/api/iot/mqtt/devices/${deviceId}/request-status`),
    resetDevice: (deviceId) => api.post(`/api/iot/mqtt/devices/${deviceId}/reset`),
    restartCamera: (deviceId) => api.post(`/api/iot/mqtt/devices/${deviceId}/restart-camera`),
    setAutoConfig: (deviceId, enabled, seconds) =>
        api.post(`/api/iot/mqtt/devices/${deviceId}/auto-config`, { enabled, seconds }),

    // OTA
    otaCheck: (deviceId) => api.post(`/api/iot/mqtt/devices/${deviceId}/ota/check`),
    otaUpdate: (deviceId) => api.post(`/api/iot/mqtt/devices/${deviceId}/ota/update`),

    // Broadcast
    broadcastCapture: () => api.post('/api/iot/mqtt/broadcast/capture'),

    // Events polling
    getEvents: (params = {}) => api.get('/api/iot/mqtt/events', { params }),
    getLatestEvents: (limit = 20) => api.get('/api/iot/mqtt/events/latest', { params: { limit } }),

    // Image management
    getImages: (params = {}) => {
        const queryParams = new URLSearchParams(params);
        return api.get(`/api/cam/images?${queryParams}`);
    },
    getImageById: (imageId) => api.get(`/api/cam/images/${imageId}`),
    deleteImage: (imageId) => api.delete(`/api/cam/images/${imageId}`),
    downloadImage: (imageId) => api.get(`/api/cam/images/${imageId}/download`, { responseType: 'blob' }),
    // Serve image directly (no MinIO auth needed - backend proxies from MinIO)
    getImageServeUrl: (imageId) => `/api/cam/images/${imageId}/serve`,

    // Statistics
    getStats: () => api.get('/api/cam/stats'),
    getDeviceStats: (deviceId) => api.get(`/api/cam/stats/${deviceId}`),

    // Health check
    getHealth: () => api.get('/api/health'),

    // Upload (testing)
    uploadImage: (formData) => api.post('/api/iot/cam/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
};

export default api;
