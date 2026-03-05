import React, { useState, useCallback } from 'react';
import { Tag, Tooltip } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import { apiService } from '../services/api';
import usePolling from '../hooks/usePolling';
import './StatusBadge.css';

const MqttIndicator = () => {
    const [connected, setConnected] = useState(false);
    const [enabled, setEnabled] = useState(false);

    const check = useCallback(async () => {
        try {
            const res = await apiService.getMqttStatus();
            setConnected(res.data.connected);
            setEnabled(res.data.enabled);
        } catch {
            setConnected(false);
        }
    }, []);

    usePolling(check, 10000, true, { immediate: true });

    if (!enabled) {
        return (
            <Tooltip title="Đã tắt MQTT">
                <Tag color="default"><ApiOutlined /> MQTT Off</Tag>
            </Tooltip>
        );
    }

    return (
        <Tooltip title={connected ? 'MQTT đã kết nối' : 'MQTT mất kết nối'}>
            <Tag color={connected ? 'success' : 'error'} className="status-badge">
                <span className={`status-dot ${connected ? 'status-dot--online' : 'status-dot--offline'}`} />
                <ApiOutlined /> MQTT
            </Tag>
        </Tooltip>
    );
};

export default MqttIndicator;
