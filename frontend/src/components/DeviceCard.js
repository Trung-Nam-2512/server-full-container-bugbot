import React from 'react';
import { Card, Typography, Space, Button, Tooltip } from 'antd';
import { CameraOutlined, PlayCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import StatusBadge from './StatusBadge';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/vi';

dayjs.extend(relativeTime);
dayjs.locale('vi');

const { Text } = Typography;

const DeviceCard = ({ device, onCapture, onDetail }) => {
    return (
        <Card
            hoverable
            className="device-card-item"
            onClick={() => onDetail?.(device.deviceId)}
            actions={[
                <Tooltip title="Chụp ảnh" key="capture">
                    <Button
                        type="text"
                        icon={<PlayCircleOutlined />}
                        onClick={(e) => { e.stopPropagation(); onCapture?.(device.deviceId); }}
                    />
                </Tooltip>,
                <Tooltip title="Chi tiết" key="detail">
                    <Button
                        type="text"
                        icon={<InfoCircleOutlined />}
                        onClick={(e) => { e.stopPropagation(); onDetail?.(device.deviceId); }}
                    />
                </Tooltip>,
            ]}
        >
            <Card.Meta
                avatar={
                    <CameraOutlined style={{ fontSize: 28, color: device.online ? '#52c41a' : '#d9d9d9' }} />
                }
                title={
                    <Space>
                        <Text strong style={{ fontSize: 14 }}>{device.deviceId}</Text>
                        <StatusBadge device={device} />
                    </Space>
                }
                description={
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        {device.firmware && (
                            <Text type="secondary" style={{ fontSize: 12 }}>FW: {device.firmware}</Text>
                        )}
                        {device.ip && (
                            <Text type="secondary" style={{ fontSize: 12 }}>IP: {device.ip}</Text>
                        )}
                        <Text type="secondary" style={{ fontSize: 11 }}>
                            {device.lastSeenAt ? dayjs(device.lastSeenAt).fromNow() : 'Chưa kết nối'}
                        </Text>
                    </Space>
                }
            />
        </Card>
    );
};

export default DeviceCard;
