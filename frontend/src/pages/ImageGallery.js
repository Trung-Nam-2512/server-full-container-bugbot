import React, { useState, useEffect } from 'react';
import {
    Row, Col, Card, Image, Button, Space, Typography, Input, Select,
    DatePicker, Tag, Modal, message, Spin, Empty, Pagination, Tooltip
} from 'antd';
import {
    DownloadOutlined, EyeOutlined, DeleteOutlined, SearchOutlined,
    FilterOutlined, CalendarOutlined, CameraOutlined, FileImageOutlined
} from '@ant-design/icons';
import { apiService } from '../services/api';
import usePolling from '../hooks/usePolling';
import { POLLING_CONFIG } from '../utils/constants';
import { handleApiError, formatErrorMessage } from '../utils/errorHandler';
import { ImageGallerySkeleton } from '../components/LoadingSkeleton';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { Search } = Input;
const { RangePicker } = DatePicker;
const { Option } = Select;

const ImageGallery = () => {
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(false);
    const [devices, setDevices] = useState([]);
    const [pagination, setPagination] = useState({
        current: 1,
        pageSize: 12,
        total: 0
    });
    const [filters, setFilters] = useState({
        search: '',
        deviceId: '',
        dateRange: null,
        sortBy: 'createdAt',
        sortOrder: 'desc'
    });
    const [selectedImages, setSelectedImages] = useState([]);
    const [previewImage, setPreviewImage] = useState(null);

    const fetchImages = async () => {
        try {
            setLoading(true);
            const params = {
                page: pagination.current,
                limit: pagination.pageSize,
                search: filters.search,
                deviceId: filters.deviceId,
                sortBy: filters.sortBy,
                sortOrder: filters.sortOrder
            };

            if (filters.dateRange && filters.dateRange.length === 2) {
                params.startDate = filters.dateRange[0].format('YYYY-MM-DD');
                params.endDate = filters.dateRange[1].format('YYYY-MM-DD');
            }

            const response = await apiService.getImages(params);
            setImages(response.data.images || []);
            setPagination(prev => ({
                ...prev,
                total: response.data.total || 0
            }));
        } catch (error) {
            handleApiError(error, {
                defaultMessage: 'Không thể tải danh sách ảnh',
                showNotification: true
            });
        } finally {
            setLoading(false);
        }
    };

    const fetchDevices = async () => {
        try {
            const response = await apiService.getDevices();
            // Lọc bỏ các device không mong muốn (cam-test, cam-test-fixed)
            const filteredDevices = (response.data.devices || []).filter(
                device => !(device.deviceId || device.id || '').includes('cam-test')
            );
            setDevices(filteredDevices);
        } catch (error) {
            // Silent fail - không hiển thị error nếu không lấy được devices
            console.warn('Could not fetch devices for filter:', error);
        }
    };

    useEffect(() => {
        fetchImages();
        fetchDevices();
    }, [pagination.current, pagination.pageSize, filters]);

    // Auto refresh every 60 seconds when enabled
    usePolling(fetchImages, POLLING_CONFIG.GALLERY_INTERVAL, autoRefresh);

    const handleDownload = async (image) => {
        try {
            const response = await apiService.downloadImage(image.id);
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.download = image.filename || `image_${image.id}.jpg`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
            message.success('Tải ảnh thành công');
        } catch (error) {
            const errorInfo = handleApiError(error, {
                defaultMessage: 'Không thể tải ảnh',
                showNotification: false
            });
            message.error(errorInfo.message || 'Lỗi khi tải ảnh');
        }
    };

    const handleDownloadSelected = async () => {
        if (selectedImages.length === 0) {
            message.warning('Vui lòng chọn ảnh để tải về');
            return;
        }

        try {
            for (const image of selectedImages) {
                await handleDownload(image);
                // Add small delay between downloads
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            message.success(`Đã tải ${selectedImages.length} ảnh`);
            setSelectedImages([]);
        } catch (error) {
            message.error('Lỗi khi tải ảnh');
        }
    };

    const handleDelete = async (image) => {
        Modal.confirm({
            title: 'Xác nhận xóa',
            content: 'Bạn có chắc chắn muốn xóa ảnh này?',
            onOk: async () => {
                try {
                    await apiService.deleteImage(image.id);
                    message.success('Xóa ảnh thành công');
                    fetchImages();
                } catch (error) {
                    const errorInfo = handleApiError(error, {
                        defaultMessage: 'Không thể xóa ảnh',
                        showNotification: false
                    });
                    message.error(errorInfo.message || 'Lỗi khi xóa ảnh');
                }
            }
        });
    };

    const handleImageSelect = (image, checked) => {
        if (checked) {
            setSelectedImages(prev => [...prev, image]);
        } else {
            setSelectedImages(prev => prev.filter(img => img.id !== image.id));
        }
    };

    const formatDate = (dateString) => {
        return dayjs(dateString).format('DD/MM/YYYY HH:mm');
    };

    const formatFileSize = (bytes) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <div>
            <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <Title level={2} style={{ margin: 0 }}>Thư viện ảnh</Title>
                    <Space>
                        <Button
                            type={autoRefresh ? 'primary' : 'default'}
                            onClick={() => setAutoRefresh(!autoRefresh)}
                        >
                            {autoRefresh ? 'Tắt auto-refresh' : 'Bật auto-refresh'}
                        </Button>
                        <Button
                            icon={<SearchOutlined />}
                            onClick={fetchImages}
                            loading={loading}
                        >
                            Làm mới
                        </Button>
                    </Space>
                </div>

                {/* Filters */}
                <Card style={{ marginBottom: 16 }}>
                    <Row gutter={[16, 16]} align="middle">
                        <Col xs={24} sm={12} md={6}>
                            <Search
                                placeholder="Tìm kiếm ảnh..."
                                value={filters.search}
                                onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
                                onSearch={fetchImages}
                                enterButton={<SearchOutlined />}
                            />
                        </Col>

                        <Col xs={24} sm={12} md={6}>
                            <Select
                                placeholder="Chọn thiết bị"
                                value={filters.deviceId}
                                onChange={(value) => setFilters(prev => ({ ...prev, deviceId: value }))}
                                style={{ width: '100%' }}
                                allowClear
                                showSearch
                                filterOption={(input, option) =>
                                    (option?.children ?? '').toLowerCase().includes(input.toLowerCase())
                                }
                            >
                                {devices.map(device => (
                                    <Option key={device.deviceId || device.id} value={device.deviceId || device.id}>
                                        {device.deviceId || device.id}
                                    </Option>
                                ))}
                            </Select>
                        </Col>

                        <Col xs={24} sm={12} md={6}>
                            <RangePicker
                                value={filters.dateRange}
                                onChange={(dates) => setFilters(prev => ({ ...prev, dateRange: dates }))}
                                style={{ width: '100%' }}
                            />
                        </Col>

                        <Col xs={24} sm={12} md={6}>
                            <Select
                                value={`${filters.sortBy}-${filters.sortOrder}`}
                                onChange={(value) => {
                                    const [sortBy, sortOrder] = value.split('-');
                                    setFilters(prev => ({ ...prev, sortBy, sortOrder }));
                                }}
                                style={{ width: '100%' }}
                            >
                                <Option value="createdAt-desc">Mới nhất</Option>
                                <Option value="createdAt-asc">Cũ nhất</Option>
                                <Option value="filename-asc">Tên A-Z</Option>
                                <Option value="filename-desc">Tên Z-A</Option>
                                <Option value="size-desc">Kích thước lớn nhất</Option>
                                <Option value="size-asc">Kích thước nhỏ nhất</Option>
                            </Select>
                        </Col>
                    </Row>
                </Card>

                {/* Actions */}
                {selectedImages.length > 0 && (
                    <Card style={{ marginBottom: 16, background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                        <Space>
                            <Text strong>{selectedImages.length} ảnh đã chọn</Text>
                            <Button
                                type="primary"
                                icon={<DownloadOutlined />}
                                onClick={handleDownloadSelected}
                            >
                                Tải tất cả
                            </Button>
                            <Button
                                icon={<DeleteOutlined />}
                                danger
                                onClick={() => {
                                    Modal.confirm({
                                        title: 'Xác nhận xóa',
                                        content: `Bạn có chắc chắn muốn xóa ${selectedImages.length} ảnh đã chọn?`,
                                        onOk: async () => {
                                            try {
                                                for (const image of selectedImages) {
                                                    await apiService.deleteImage(image.id);
                                                }
                                                message.success(`Đã xóa ${selectedImages.length} ảnh`);
                                                setSelectedImages([]);
                                                fetchImages();
                                            } catch (error) {
                                                message.error('Lỗi khi xóa ảnh');
                                            }
                                        }
                                    });
                                }}
                            >
                                Xóa tất cả
                            </Button>
                        </Space>
                    </Card>
                )}
            </div>

            {/* Image Grid */}
            {loading && images.length === 0 ? (
                <ImageGallerySkeleton />
            ) : (
                <Spin spinning={loading}>
                    {images.length === 0 ? (
                        <Empty
                            image={<FileImageOutlined style={{ fontSize: 64, color: '#d9d9d9' }} />}
                            description="Không có ảnh nào"
                        />
                    ) : (
                        <>
                            <Row gutter={[16, 16]}>
                                {images.map((image) => (
                                    <Col xs={24} sm={12} md={8} lg={6} key={image.id}>
                                        <Card
                                            className="image-card"
                                            hoverable
                                            cover={
                                                <div style={{ position: 'relative' }}>
                                                    <Image
                                                        src={apiService.getImageServeUrl(image.id)}
                                                        alt={image.filename}
                                                        style={{ height: 200, objectFit: 'cover' }}
                                                        preview={false}
                                                        onClick={() => setPreviewImage(image)}
                                                    />

                                                    <div style={{ position: 'absolute', top: 8, left: 8 }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedImages.some(img => img.id === image.id)}
                                                            onChange={(e) => handleImageSelect(image, e.target.checked)}
                                                            style={{ transform: 'scale(1.2)' }}
                                                        />
                                                    </div>

                                                    <div style={{ position: 'absolute', top: 8, right: 8 }}>
                                                        <Space>
                                                            <Tooltip title="Xem">
                                                                <Button
                                                                    type="primary"
                                                                    size="small"
                                                                    icon={<EyeOutlined />}
                                                                    onClick={() => setPreviewImage(image)}
                                                                />
                                                            </Tooltip>
                                                            <Tooltip title="Tải về">
                                                                <Button
                                                                    size="small"
                                                                    icon={<DownloadOutlined />}
                                                                    onClick={() => handleDownload(image)}
                                                                />
                                                            </Tooltip>
                                                            <Tooltip title="Xóa">
                                                                <Button
                                                                    size="small"
                                                                    danger
                                                                    icon={<DeleteOutlined />}
                                                                    onClick={() => handleDelete(image)}
                                                                />
                                                            </Tooltip>
                                                        </Space>
                                                    </div>
                                                </div>
                                            }
                                        >
                                            <Card.Meta
                                                title={
                                                    <Text ellipsis style={{ fontSize: '14px' }}>
                                                        {image.filename || `Image ${image.id}`}
                                                    </Text>
                                                }
                                                description={
                                                    <Space direction="vertical" size={4}>
                                                        <Space>
                                                            <Tag color="blue" icon={<CameraOutlined />}>
                                                                {image.deviceId}
                                                            </Tag>
                                                            <Text type="secondary" style={{ fontSize: '12px' }}>
                                                                {formatFileSize(image.size)}
                                                            </Text>
                                                        </Space>
                                                        <Space>
                                                            <CalendarOutlined />
                                                            <Text type="secondary" style={{ fontSize: '12px' }}>
                                                                {formatDate(image.createdAt)}
                                                            </Text>
                                                        </Space>
                                                    </Space>
                                                }
                                            />
                                        </Card>
                                    </Col>
                                ))}
                            </Row>

                            {/* Pagination */}
                            <div style={{ textAlign: 'center', marginTop: 24 }}>
                                <Pagination
                                    current={pagination.current}
                                    pageSize={pagination.pageSize}
                                    total={pagination.total}
                                    onChange={(page, pageSize) => {
                                        setPagination(prev => ({
                                            ...prev,
                                            current: page,
                                            pageSize: pageSize || prev.pageSize
                                        }));
                                    }}
                                    showSizeChanger
                                    showQuickJumper
                                    showTotal={(total, range) =>
                                        `${range[0]}-${range[1]} của ${total} ảnh`
                                    }
                                />
                            </div>
                        </>
                    )}
                </Spin>
            )}

            {/* Image Preview Modal */}
            <Modal
                open={!!previewImage}
                onCancel={() => setPreviewImage(null)}
                footer={null}
                width="80%"
                style={{ top: 20 }}
            >
                {previewImage && (
                    <div style={{ textAlign: 'center' }}>
                        <Image
                            src={apiService.getImageServeUrl(previewImage.id)}
                            alt={previewImage.filename}
                            className="fullscreen-image"
                        />
                        <div style={{ marginTop: 16 }}>
                            <Space>
                                <Button
                                    type="primary"
                                    icon={<DownloadOutlined />}
                                    onClick={() => handleDownload(previewImage)}
                                >
                                    Tải về
                                </Button>
                                <Button
                                    danger
                                    icon={<DeleteOutlined />}
                                    onClick={() => {
                                        handleDelete(previewImage);
                                        setPreviewImage(null);
                                    }}
                                >
                                    Xóa
                                </Button>
                            </Space>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
};

export default ImageGallery;
