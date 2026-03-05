import React, { useState } from 'react';
import {
    Card, Table, Button, Space, Typography, Modal, Form,
    InputNumber, Switch, message, Row, Col, Statistic,
} from 'antd';
import {
    CameraOutlined, PlayCircleOutlined, SettingOutlined,
    ReloadOutlined, DeleteOutlined, SendOutlined, InfoCircleOutlined,
    PoweroffOutlined, SyncOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../services/api';
import useDevices from '../hooks/useDevices';
import StatusBadge from '../components/StatusBadge';
import { handleApiError, formatErrorMessage } from '../utils/errorHandler';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/vi';

dayjs.extend(relativeTime);
dayjs.locale('vi');

const { Title } = Typography;

const DeviceManagement = () => {
    const [autoRefresh, setAutoRefresh] = useState(true);
    const { devices, counts, loading, refresh } = useDevices(autoRefresh);
    const [configModalVisible, setConfigModalVisible] = useState(false);
    const [selectedDevice, setSelectedDevice] = useState(null);
    const [form] = Form.useForm();
    const navigate = useNavigate();

    const sendCmd = async (deviceId, label, apiFn) => {
        try {
            await apiFn();
            message.success(`"${label}" gửi đến ${deviceId}`);
        } catch (error) {
            message.error(formatErrorMessage(error));
        }
    };

    const handleConfig = (device) => {
        setSelectedDevice(device);
        form.setFieldsValue({
            autoEnabled: device.autoMode || false,
            intervalSeconds: device.intervalSec || 30,
        });
        setConfigModalVisible(true);
    };

    const handleConfigSubmit = async (values) => {
        try {
            await apiService.setAutoConfig(selectedDevice.deviceId, values.autoEnabled, values.intervalSeconds);
            message.success('Cập nhật cấu hình thành công');
            setConfigModalVisible(false);
            refresh();
        } catch (error) {
            message.error(formatErrorMessage(error));
        }
    };

    const handleDelete = (device) => {
        Modal.confirm({
            title: 'Xác nhận xóa thiết bị',
            content: (
                <div>
                    <p>Bạn có chắc chắn muốn xóa thiết bị <strong>{device.deviceId}</strong>?</p>
                    <p style={{ color: '#ff4d4f' }}>Hành động này không thể hoàn tác.</p>
                </div>
            ),
            okText: 'Xóa', okType: 'danger', cancelText: 'Hủy',
            onOk: async () => {
                try {
                    await apiService.deleteDevice(device.deviceId);
                    message.success(`Đã xóa ${device.deviceId}`);
                    refresh();
                } catch (error) {
                    handleApiError(error, { defaultMessage: 'Không thể xóa thiết bị' });
                }
            },
        });
    };

    const columns = [
        {
            title: 'Thiết bị',
            dataIndex: 'deviceId',
            key: 'deviceId',
            render: (text) => (
                <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/devices/${text}`)}>
                    <CameraOutlined style={{ marginRight: 6 }} />{text}
                </Button>
            ),
        },
        {
            title: 'Trạng thái',
            key: 'status',
            width: 110,
            render: (_, record) => <StatusBadge device={record} />,
        },
        {
            title: 'Firmware',
            dataIndex: 'firmware',
            key: 'firmware',
            width: 90,
            render: (fw) => fw || '-',
        },
        {
            title: 'IP',
            dataIndex: 'ip',
            key: 'ip',
            width: 130,
            render: (ip) => ip || '-',
        },
        {
            title: 'Uptime',
            dataIndex: 'uptime',
            key: 'uptime',
            width: 90,
            render: (val) => {
                if (val == null) return '-';
                const h = Math.floor(val / 3600);
                const m = Math.floor((val % 3600) / 60);
                return h > 0 ? `${h}h ${m}m` : `${m}m`;
            },
        },
        {
            title: 'Lần cuối',
            dataIndex: 'lastSeenAt',
            key: 'lastSeenAt',
            width: 130,
            render: (date) => date ? dayjs(date).fromNow() : '-',
        },
        {
            title: 'Hành động',
            key: 'actions',
            width: 320,
            render: (_, record) => (
                <Space size={4} wrap>
                    <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                        onClick={() => sendCmd(record.deviceId, 'capture', () => apiService.capturePhoto(record.deviceId))}>
                        Chụp
                    </Button>
                    <Button size="small" icon={<SyncOutlined />}
                        onClick={() => sendCmd(record.deviceId, 'ota_check', () => apiService.otaCheck(record.deviceId))}>
                        OTA
                    </Button>
                    <Button size="small" icon={<SettingOutlined />} onClick={() => handleConfig(record)}>
                        Config
                    </Button>
                    <Button size="small" icon={<InfoCircleOutlined />} onClick={() => navigate(`/devices/${record.deviceId}`)}>
                        Chi tiết
                    </Button>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)} />
                </Space>
            ),
        },
    ];

    return (
        <div>
            {/* Header */}
            <div className="page-header">
                <Title level={2} style={{ margin: 0 }}>Quản lý thiết bị</Title>
                <Space>
                    <Button icon={<SendOutlined />}
                        onClick={() => sendCmd('all', 'broadcast capture', () => apiService.broadcastCapture())}>
                        Capture All
                    </Button>
                    <Switch checked={autoRefresh} onChange={setAutoRefresh} checkedChildren="Auto" unCheckedChildren="Manual" />
                    <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>Làm mới</Button>
                </Space>
            </div>

            {/* Stats */}
            <Row gutter={16} style={{ marginBottom: 24 }}>
                <Col xs={24} sm={8}>
                    <Card className="stats-card">
                        <Statistic title="Tổng thiết bị" value={counts.total} prefix={<CameraOutlined />} valueStyle={{ color: '#1890ff' }} />
                    </Card>
                </Col>
                <Col xs={24} sm={8}>
                    <Card className="stats-card">
                        <Statistic title="Online" value={counts.online} prefix={<PlayCircleOutlined />} valueStyle={{ color: '#52c41a' }} />
                    </Card>
                </Col>
                <Col xs={24} sm={8}>
                    <Card className="stats-card">
                        <Statistic
                            title="Tỷ lệ online"
                            value={counts.total > 0 ? ((counts.online / counts.total) * 100).toFixed(1) : 0}
                            suffix="%" valueStyle={{ color: '#722ed1' }}
                        />
                    </Card>
                </Col>
            </Row>

            {/* Table */}
            <Card>
                <Table
                    columns={columns}
                    dataSource={devices}
                    rowKey="deviceId"
                    loading={loading}
                    pagination={{
                        pageSize: 10, showSizeChanger: true, showQuickJumper: true,
                        showTotal: (total, range) => `${range[0]}-${range[1]} của ${total} thiết bị`,
                    }}
                    onRow={(record) => ({
                        onClick: () => navigate(`/devices/${record.deviceId}`),
                        style: { cursor: 'pointer' },
                    })}
                    size="middle"
                />
            </Card>

            {/* Config modal */}
            <Modal
                title={`Cấu hình ${selectedDevice?.deviceId}`}
                open={configModalVisible}
                onCancel={() => setConfigModalVisible(false)}
                onOk={() => form.submit()}
                width={420}
            >
                <Form form={form} layout="vertical" onFinish={handleConfigSubmit}>
                    <Form.Item name="autoEnabled" label="Tự động chụp" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    <Form.Item
                        name="intervalSeconds" label="Chu kỳ chụp (giây)"
                        rules={[
                            { required: true, message: 'Nhập chu kỳ' },
                            { type: 'number', min: 3, max: 3600, message: '3 - 3600 giây' },
                        ]}
                    >
                        <InputNumber min={3} max={3600} style={{ width: '100%' }} addonAfter="giây" />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
};

export default DeviceManagement;
