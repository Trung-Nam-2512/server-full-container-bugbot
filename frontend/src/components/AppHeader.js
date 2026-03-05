import React from 'react';
import { Layout, Space, Button, Badge, Dropdown, Avatar } from 'antd';
import { BellOutlined, UserOutlined, SettingOutlined, LogoutOutlined } from '@ant-design/icons';
import MqttIndicator from './MqttIndicator';

const { Header } = Layout;

const AppHeader = () => {
    const userMenuItems = [
        { key: 'profile', icon: <UserOutlined />, label: 'Hồ sơ' },
        { key: 'settings', icon: <SettingOutlined />, label: 'Cài đặt' },
        { type: 'divider' },
        { key: 'logout', icon: <LogoutOutlined />, label: 'Đăng xuất' },
    ];

    return (
        <Header className="dashboard-header" style={{ paddingLeft: 24, paddingRight: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '100%' }}>
                <div />

                <Space size="middle">
                    <MqttIndicator />

                    <Badge count={0} size="small">
                        <Button type="text" icon={<BellOutlined />} size="large" />
                    </Badge>

                    <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" arrow>
                        <Button type="text" style={{ padding: 0 }}>
                            <Avatar icon={<UserOutlined />} style={{ backgroundColor: '#1890ff' }} />
                        </Button>
                    </Dropdown>
                </Space>
            </div>
        </Header>
    );
};

export default AppHeader;
