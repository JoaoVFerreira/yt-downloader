const urlInput = document.getElementById('videoUrl');
const downloadBtn = document.getElementById('downloadBtn');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusText = document.getElementById('statusText');
const result = document.getElementById('result');
const videoInfo = document.getElementById('videoInfo');
const downloadSection = document.getElementById('downloadSection');
const downloadFileBtn = document.getElementById('downloadFileBtn');

let currentFilename = null;
let progressSimulation = null;

downloadBtn.addEventListener('click', async () => {
    
    const url = urlInput.value.trim();
    if (!url) {
        showResult('Por favor, insira uma URL válida.', 'error');
        return;
    }
    
    try {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = '⏳ Processando...';
        downloadBtn.style.backgroundColor = '#FFD700';
        downloadBtn.style.color = '#333';
        result.style.display = 'none';
        videoInfo.style.display = 'none';
        downloadSection.style.display = 'none';
        progressContainer.style.display = 'block';
        
        // Inicia a simulação do progresso
        progressSimulation = simulateProgress();
        
        const response = await fetch('/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url }),
        });
        
        console.log('Status da resposta:', response.status);
        
        if (!response.ok) {
            const errorData = await response.json();
            console.error('Erro no servidor:', errorData);
            throw new Error(errorData.error || 'Erro no servidor');
        }
        
        const data = await response.json();
        console.log('Dados recebidos do servidor:', data);
        
        if (data.success) {
            currentFilename = data.data.filename;
            console.log('Nome do arquivo:', currentFilename);
            
            // Mostrar informações do vídeo
            showVideoInfo(data.data);
            
            // Mostrar mensagem de sucesso
            showResult(`✅ Download concluído! Clique no botão abaixo para baixar.`, 'success');
            
            // Mostrar botão de download
            downloadSection.style.display = 'block';
            console.log('Seção de download exibida');
        } else {
            throw new Error(data.error || 'Falha no download');
        }
        
    } catch (error) {
        showResult(`❌ Erro: ${error.message}`, 'error');
    } finally {
        // Para a simulação do progresso se ainda estiver rodando
        if (progressSimulation) {
            progressSimulation.stop();
            progressSimulation = null;
        }
        
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = '<span class="o-letter">O</span><span class="k-letter">K</span>';
        downloadBtn.style.backgroundColor = '#FFEB82';
        downloadBtn.style.color = '#FF7700';
        progressContainer.style.display = 'none';
        resetProgress();
    }
});

downloadFileBtn.addEventListener('click', async () => {
    console.log('Botão de download clicado');
    console.log('currentFilename:', currentFilename);
    
    if (!currentFilename) {
        console.log('Nenhum arquivo disponível para download');
        showResult('❌ Nenhum arquivo disponível para download', 'error');
        return;
    }
    
    try {
        downloadFileBtn.disabled = true;
        downloadFileBtn.innerHTML = '⏳ Baixando...';
        
        const downloadUrl = `/download-file/${encodeURIComponent(currentFilename)}`;
        console.log('URL de download:', downloadUrl);
        
        // Método otimizado para download direto no browser
        try {
            // Verifica se o arquivo existe no servidor
            const response = await fetch(downloadUrl, { method: 'HEAD' });
            
            if (!response.ok) {
                throw new Error('Arquivo não encontrado no servidor');
            }
            
            console.log('Arquivo verificado, iniciando download direto...');
            
            // Download direto usando fetch com blob
            const downloadResponse = await fetch(downloadUrl);
            if (!downloadResponse.ok) {
                throw new Error('Falha no download do arquivo');
            }
            
            const blob = await downloadResponse.blob();
            const url = window.URL.createObjectURL(blob);
            
            // Cria link temporário para download
            const link = document.createElement('a');
            link.href = url;
            link.download = currentFilename;
            link.style.display = 'none';
            
            document.body.appendChild(link);
            link.click();
            
            // Cleanup
            setTimeout(() => {
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);
            }, 100);
            
            showResult('✅ Download concluído! Arquivo salvo na pasta de downloads.', 'success');
            
        } catch (fetchError) {
            console.error('Erro no download via fetch:', fetchError);
            
            // Fallback: método tradicional
            console.log('Usando método tradicional de download...');
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = currentFilename;
            link.target = '_blank';
            link.style.display = 'none';
            
            document.body.appendChild(link);
            link.click();
            
            setTimeout(() => {
                if (document.body.contains(link)) {
                    document.body.removeChild(link);
                }
            }, 1000);
            
            showResult('📥 Download iniciado! Verifique sua pasta de downloads.', 'success');
        }
        
        // Aguarda e limpa arquivo do servidor após download
        setTimeout(async () => {
            try {
                console.log('Solicitando limpeza do arquivo do servidor...');
                const response = await fetch('/cleanup-file', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ filename: currentFilename }),
                });
                
                if (response.ok) {
                    console.log('Arquivo removido do servidor com sucesso');
                    currentFilename = null;
                    downloadSection.style.display = 'none';
                    videoInfo.style.display = 'none';
                    showResult('✅ Download realizado com sucesso! Arquivo removido do servidor para economizar espaço.', 'success');
                } else {
                    console.log('Falha ao remover arquivo do servidor');
                }
            } catch (error) {
                console.error('Erro ao solicitar limpeza:', error);
            }
        }, 2000); // Aguarda 2 segundos antes de limpar
        
    } catch (error) {
        console.error('Erro no download:', error);
        showResult(`❌ Erro ao iniciar download: ${error.message}`, 'error');
    } finally {
        setTimeout(() => {
            downloadFileBtn.disabled = false;
            downloadFileBtn.innerHTML = '💾 Baixar Arquivo';
        }, 1000);
    }
});

urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        downloadBtn.click();
    }
});

function showResult(message, type) {
    result.textContent = message;
    result.className = `result ${type}`;
    result.style.display = 'block';
    
    if (type === 'success') {
        result.style.background = '#d4edda';
        result.style.color = '#155724';
        result.style.border = '1px solid #c3e6cb';
    } else {
        result.style.background = '#f8d7da';
        result.style.color = '#721c24';
        result.style.border = '1px solid #f5c6cb';
    }
}

function showVideoInfo(info) {
    console.log('Recebendo informações do vídeo:', info);
    
    if (!info) {
        console.log('Nenhuma informação do vídeo recebida');
        return;
    }
    
    const videoDetails = document.getElementById('videoDetails');
    
    if (!videoDetails) {
        console.log('Elemento videoDetails não encontrado');
        return;
    }
    
    // Formatar número de views
    const formatViews = (views) => {
        if (!views || views === 'N/A') return 'N/A';
        const num = parseInt(views);
        if (isNaN(num)) return views;
        
        if (num >= 1000000000) {
            return (num / 1000000000).toFixed(1) + 'B';
        } else if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toLocaleString();
    };
    
    const formattedViews = formatViews(info.views);
    
    // Detecta se é mobile para ajustar layout
    const isMobile = window.innerWidth <= 600;
    const gridColumns = isMobile ? '1fr' : '1fr 1fr';
    
    videoDetails.innerHTML = `
        <div style="display: grid; gap: 15px;">
            <div style="background: rgba(255, 235, 130, 0.2); border-radius: 12px; padding: 15px;">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                    <span style="font-size: 18px;">🎬</span>
                    <span style="font-weight: bold; color: #FF7700; font-size: 16px;">Título:</span>
                </div>
                <div style="color: #333; font-size: 15px; line-height: 1.4; word-wrap: break-word; padding-left: 28px;">${info.title || 'N/A'}</div>
            </div>
            
            <div style="display: grid; grid-template-columns: ${gridColumns}; gap: 15px;">
                <div style="background: rgba(255, 235, 130, 0.2); border-radius: 12px; padding: 15px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 16px;">👤</span>
                        <span style="font-weight: bold; color: #FF7700;">Autor:</span>
                    </div>
                    <div style="color: #333; font-size: 14px; padding-left: 24px;">${info.author || 'N/A'}</div>
                </div>
                
                <div style="background: rgba(255, 235, 130, 0.2); border-radius: 12px; padding: 15px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 16px;">⏱️</span>
                        <span style="font-weight: bold; color: #FF7700;">Duração:</span>
                    </div>
                    <div style="color: #333; font-size: 14px; font-weight: bold; padding-left: 24px;">${info.duration || 'N/A'}</div>
                </div>
            </div>
            
            <div style="display: grid; grid-template-columns: ${gridColumns}; gap: 15px;">
                <div style="background: rgba(255, 235, 130, 0.2); border-radius: 12px; padding: 15px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 16px;">👁️</span>
                        <span style="font-weight: bold; color: #FF7700;">Views:</span>
                    </div>
                    <div style="color: #333; font-size: 14px; font-weight: bold; padding-left: 24px;">${formattedViews}</div>
                </div>
                
                <div style="background: rgba(255, 235, 130, 0.2); border-radius: 12px; padding: 15px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 16px;">🎯</span>
                        <span style="font-weight: bold; color: #FF7700;">Qualidade:</span>
                    </div>
                    <div style="color: #333; font-size: 14px; font-weight: bold; padding-left: 24px;">${info.quality || 'HD'}</div>
                </div>
            </div>
        </div>
    `;
    videoInfo.style.display = 'block';
    console.log('Informações do vídeo exibidas com sucesso');
}

function simulateProgress() {
    let progress = 0;
    let currentStage = 0;
    let isRunning = true;
    let intervals = [];
    let timeouts = [];
    
    const stages = [
        {
            name: '🔍 Verificando URL...',
            status: 'Analisando link do YouTube',
            duration: 1500,
            progressRange: [0, 15]
        },
        {
            name: '📋 Obtendo informações do vídeo...',
            status: 'Coletando metadados do vídeo',
            duration: 2000,
            progressRange: [15, 30]
        },
        {
            name: '🎬 Baixando vídeo...',
            status: 'Fazendo download da qualidade HD',
            duration: 4000,
            progressRange: [30, 70]
        },
        {
            name: '🎵 Baixando áudio...',
            status: 'Extraindo faixa de áudio de alta qualidade',
            duration: 3000,
            progressRange: [70, 85]
        },
        {
            name: '🔧 Mesclando arquivos...',
            status: 'Combinando vídeo e áudio usando FFmpeg',
            duration: 2000,
            progressRange: [85, 95]
        },
        {
            name: '✨ Finalizando...',
            status: 'Preparando arquivo para download',
            duration: 1000,
            progressRange: [95, 100]
        }
    ];
    
    function updateStage() {
        if (!isRunning || currentStage >= stages.length) return;
        
        const stage = stages[currentStage];
        const [minProgress, maxProgress] = stage.progressRange;
        
        progressText.textContent = stage.name;
        statusText.textContent = stage.status;
        
        progress = minProgress;
        progressFill.style.width = progress + '%';
        
        // Simula progresso suave dentro da etapa
        const stageInterval = setInterval(() => {
            if (!isRunning) {
                clearInterval(stageInterval);
                return;
            }
            
            const incrementSize = (maxProgress - minProgress) / (stage.duration / 50);
            progress += incrementSize + Math.random() * 0.5;
            
            if (progress >= maxProgress) {
                progress = maxProgress;
                progressFill.style.width = Math.min(progress, 100) + '%';
                clearInterval(stageInterval);
                currentStage++;
                
                if (currentStage < stages.length && isRunning) {
                    const nextTimeout = setTimeout(updateStage, 200);
                    timeouts.push(nextTimeout);
                }
            } else {
                progressFill.style.width = Math.min(progress, 100) + '%';
            }
        }, 50);
        
        intervals.push(stageInterval);
    }
    
    // Inicia a simulação
    updateStage();
    
    // Retorna objeto com método para parar a simulação
    return {
        stop: () => {
            isRunning = false;
            intervals.forEach(interval => clearInterval(interval));
            timeouts.forEach(timeout => clearTimeout(timeout));
            intervals = [];
            timeouts = [];
            
            // Completa a barra rapidamente quando para
            progressFill.style.width = '100%';
            progressText.textContent = '✅ Concluído!';
            statusText.textContent = 'Download finalizado com sucesso';
        }
    };
}

function resetProgress() {
    progressFill.style.width = '0%';
    progressText.textContent = 'Preparando download...';
    statusText.textContent = 'Aguardando...';
}