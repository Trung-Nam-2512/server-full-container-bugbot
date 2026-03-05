import React from 'react';
import { Card, List, Tag, Typography, Empty } from 'antd';
import {
    CameraOutlined, CloudUploadOutlined, WarningOutlined,
    SyncOutlined, WifiOutlined, DisconnectOutlined, ToolOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/vi';

dayjs.extend(relativeTime);
dayjs.locale('vi');

const { Text } = Typography;

const CATEGORY_CONFIG = {
    presence: { color: 'blue', icon: <WifiOutlined /> },
    event: { color: 'green', icon: <CloudUploadOutlined /> },
    ack: { color: 'cyan', icon: <SyncOutlined /> },
    ota: { color: 'purple', icon: <ToolOutlined /> },
    warning: { color: 'orange', icon: <WarningOutlined /> },
    config: { color: 'geekblue', icon: <SyncOutlined /> },
};

function eventLabel(event) {
    if (event.type === 'online') return 'Online';
    if (event.type === 'offline') return 'Offline';
    if (event.type === 'captured') return 'Captured';
    if (event.type === 'upload_ok') return 'Upload OK';
    if (event.type === 'upload_fail') return `Upload fail: ${event.payload?.reason || ''}`;
    if (event.type === 'capture_fail') return `Capture fail: ${event.payload?.reason || ''}`;
    if (event.type?.startsWith('ota_')) return event.type.replace(/_/g, ' ');
    if (event.category === 'ack') return `ACK: ${event.type}`;
    if (event.category === 'warning') return `Warning: ${event.type}`;
    return event.type || 'Unknown';
}

const EventFeed = ({ events = [], title = 'Event Feed', maxHeight = 400, showDevice = true }) => {
    const cfg = (cat) => CATEGORY_CONFIG[cat] || { color: 'default', icon: <CameraOutlined /> };

    return (
        <Card
            title={title}
            size="small"
            bodyStyle={{ maxHeight, overflowY: 'auto', padding: 0 }}
        >
            {events.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có sự kiện nào" style={{ padding: 24 }} />
            ) : (
                <List
                    size="small"
                    dataSource={events}
                    renderItem={(event) => {
                        const c = cfg(event.category);
                        return (
                            <List.Item style={{ padding: '8px 16px' }}>
                                <List.Item.Meta
                                    avatar={c.icon}
                                    title={
                                        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                            <Tag color={c.color} style={{ margin: 0 }}>{eventLabel(event)}</Tag>
                                            {showDevice && (
                                                <Text type="secondary" style={{ fontSize: 12 }}>{event.deviceId}</Text>
                                            )}
                                        </span>
                                    }
                                    description={
                                        <Text type="secondary" style={{ fontSize: 11 }}>
                                            {dayjs(event.ts).fromNow()}
                                        </Text>
                                    }
                                />
                            </List.Item>
                        );
                    }}
                />
            )}
        </Card>
    );
};

export default EventFeed;
