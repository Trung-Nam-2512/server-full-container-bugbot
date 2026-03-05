import React, { useState } from 'react';
import { Layout, Menu, Typography } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import {
    DashboardOutlined,
    PictureOutlined,
    CameraOutlined,
    SettingOutlined,
    MenuFoldOutlined,
    MenuUnfoldOutlined,
} from '@ant-design/icons';

const { Sider } = Layout;
const { Title } = Typography;

const AppSider = () => {
    const [collapsed, setCollapsed] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();

    const menuItems = [
        { key: '/', icon: <DashboardOutlined />, label: 'Tổng quan' },
        { key: '/gallery', icon: <PictureOutlined />, label: 'Thư viện ảnh' },
        { key: '/devices', icon: <CameraOutlined />, label: 'Thiết bị' },
        { key: '/settings', icon: <SettingOutlined />, label: 'Cài đặt' },
    ];

    return (
        <Sider
            trigger={null}
            collapsible
            collapsed={collapsed}
            width={220}
            style={{
                overflow: 'auto',
                height: '100vh',
                position: 'fixed',
                left: 0,
                top: 0,
                bottom: 0,
                zIndex: 100,
            }}
            theme="dark"
        >
            {/* Logo / Brand */}
            <div
                style={{
                    height: 64,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    padding: collapsed ? 0 : '0 20px',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                    cursor: 'pointer',
                }}
                onClick={() => setCollapsed(!collapsed)}
            >
                {collapsed ? (
                    <MenuUnfoldOutlined style={{ color: '#fff', fontSize: 18 }} />
                ) : (
                    <>
                        <CameraOutlined style={{ color: '#1890ff', fontSize: 22, marginRight: 10 }} />
                        <Title level={5} style={{ color: '#fff', margin: 0, whiteSpace: 'nowrap' }}>
                            BugBot
                        </Title>
                        <MenuFoldOutlined style={{ color: 'rgba(255,255,255,0.45)', fontSize: 14, marginLeft: 'auto' }} />
                    </>
                )}
            </div>

            <Menu
                theme="dark"
                mode="inline"
                selectedKeys={[location.pathname]}
                items={menuItems}
                onClick={({ key }) => navigate(key)}
                style={{ borderRight: 0, marginTop: 8 }}
            />
        </Sider>
    );
};

export default AppSider;
