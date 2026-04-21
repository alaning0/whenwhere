import React, { useMemo, useState, useCallback, memo } from 'react';
import {
  startOfYear,
  endOfYear,
  eachMonthOfInterval,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  getHours,
  isSameDay,
  getDay,
  addYears,
  subYears,
  parseISO
} from 'date-fns';
import './CalendarOverlay.css';

// Get heatmap color based on photo count relative to max
function getDayColor(count, maxCount) {
  if (count === 0) return 'transparent';
  const intensity = count / maxCount;
  const alpha = 0.2 + (intensity * 0.7); // 0.2 to 0.9
  return `rgba(220, 60, 60, ${alpha})`;
}

// Month grid component
const MonthGrid = memo(function MonthGrid({ month, photosByDay, maxCount, onDayClick, selectedDay }) {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  
  // Get the day of week for the first day (0 = Sunday)
  const startDayOfWeek = getDay(monthStart);
  
  // Create empty slots for days before the month starts
  const emptySlots = Array(startDayOfWeek).fill(null);
  
  return (
    <div className="calendar-month">
      <div className="month-header">
        {format(month, 'MMMM')}
      </div>
      <div className="weekday-headers">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
          <div key={day} className="weekday-header">{day}</div>
        ))}
      </div>
      <div className="days-grid">
        {emptySlots.map((_, index) => (
          <div key={`empty-${index}`} className="day-cell empty"></div>
        ))}
        {days.map(day => {
          const dateKey = format(day, 'yyyy-MM-dd');
          const count = photosByDay[dateKey] || 0;
          const color = getDayColor(count, maxCount);
          const isSelected = selectedDay && isSameDay(day, selectedDay);
          
          return (
            <div
              key={dateKey}
              className={`day-cell ${count > 0 ? 'has-photos' : ''} ${isSelected ? 'selected' : ''}`}
              style={{ backgroundColor: isSelected ? 'transparent' : color }}
              onClick={() => count > 0 && onDayClick(day)}
              title={count > 0 ? `${count} photo${count !== 1 ? 's' : ''}` : ''}
            >
              <span className="day-number">{format(day, 'd')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// Year view showing all 12 months
const YearView = memo(function YearView({ year, photosByDay, maxCount, onDayClick, onYearChange, selectedDay, isCompact }) {
  const yearStart = startOfYear(year);
  const yearEnd = endOfYear(year);
  const months = eachMonthOfInterval({ start: yearStart, end: yearEnd });
  
  return (
    <div className={`calendar-year-view ${isCompact ? 'compact' : ''}`}>
      <div className="year-header">
        <button 
          className="year-nav-btn" 
          onClick={() => onYearChange(subYears(year, 1))}
          title="Previous year"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <h2 className="year-title">{format(year, 'yyyy')}</h2>
        <button 
          className="year-nav-btn" 
          onClick={() => onYearChange(addYears(year, 1))}
          title="Next year"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
      <div className="months-grid">
        {months.map(month => (
          <MonthGrid
            key={format(month, 'yyyy-MM')}
            month={month}
            photosByDay={photosByDay}
            maxCount={maxCount}
            onDayClick={onDayClick}
            selectedDay={selectedDay}
          />
        ))}
      </div>
    </div>
  );
});

// Hourly stem-and-leaf view for a selected day
const DayDetailView = memo(function DayDetailView({ 
  selectedDay, 
  photosByHour, 
  onClose,
  onPhotoClick 
}) {
  // Create array of hours 0-23
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const totalPhotos = Object.values(photosByHour).reduce((sum, arr) => sum + arr.length, 0);
  
  return (
    <div className="calendar-day-view">
      <div className="day-view-header">
        <h2 className="day-title">{format(selectedDay, 'EEEE, MMMM d')}</h2>
        <div className="day-stats">
          {totalPhotos} photo{totalPhotos !== 1 ? 's' : ''}
        </div>
        <button className="day-close-btn" onClick={onClose} title="Close day view">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      
      <div className="stem-leaf-container">
        {hours.map(hour => {
          const photos = photosByHour[hour] || [];
          const hasPhotos = photos.length > 0;
          
          if (!hasPhotos) return null; // Only show hours with photos
          
          return (
            <div key={hour} className="hour-row has-photos">
              <div className="hour-stem">
                <span className="hour-label">{hour.toString().padStart(2, '0')}</span>
                <div className="hour-line"></div>
              </div>
              <div className="hour-leaves">
                {photos.map(photo => (
                  <div 
                    key={photo.id} 
                    className={`leaf-thumbnail ${photo.isVideo ? 'is-video' : ''}`}
                    onClick={() => onPhotoClick(photo)}
                    title={`${photo.title} - ${photo.timeFormatted}`}
                  >
                    {photo.hasMediaFile && photo.thumbnail && !photo.isVideo ? (
                      <img 
                        src={photo.thumbnail} 
                        alt={photo.title} 
                        loading="lazy"
                        onLoad={(e) => e.target.classList.add('loaded')}
                      />
                    ) : (
                      <div className="thumb-placeholder">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          {photo.isVideo ? 
                            <polygon points="5 3 19 12 5 21 5 3"></polygon> :
                            <><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle></>
                          }
                        </svg>
                      </div>
                    )}
                    <span className="leaf-time">{photo.timeShort}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// Main Calendar Overlay Component
function CalendarOverlay({ photos, onClose, onPhotoSelect }) {
  // Determine initial year from photos
  const initialYear = useMemo(() => {
    if (photos.length === 0) return new Date();
    // Use the most recent photo's year
    const lastPhoto = photos[photos.length - 1];
    return parseISO(lastPhoto.date);
  }, [photos]);
  
  const [currentYear, setCurrentYear] = useState(initialYear);
  const [selectedDay, setSelectedDay] = useState(null);
  
  // Build map of date -> photo count
  const { photosByDay, maxCount } = useMemo(() => {
    const byDay = {};
    let max = 0;
    
    photos.forEach(photo => {
      const dateKey = format(parseISO(photo.date), 'yyyy-MM-dd');
      byDay[dateKey] = (byDay[dateKey] || 0) + 1;
      if (byDay[dateKey] > max) {
        max = byDay[dateKey];
      }
    });
    
    return { photosByDay: byDay, maxCount: max };
  }, [photos]);
  
  // Build map of hour -> photos for selected day
  const photosByHour = useMemo(() => {
    if (!selectedDay) return {};
    
    const byHour = {};
    
    photos.forEach(photo => {
      const photoDate = parseISO(photo.date);
      if (isSameDay(photoDate, selectedDay)) {
        const hour = getHours(photoDate);
        if (!byHour[hour]) {
          byHour[hour] = [];
        }
        byHour[hour].push(photo);
      }
    });
    
    // Sort photos within each hour by time
    Object.keys(byHour).forEach(hour => {
      byHour[hour].sort((a, b) => new Date(a.date) - new Date(b.date));
    });
    
    return byHour;
  }, [photos, selectedDay]);
  
  const handleDayClick = useCallback((day) => {
    setSelectedDay(day);
  }, []);
  
  const handleBack = useCallback(() => {
    setSelectedDay(null);
  }, []);
  
  const handlePhotoClick = useCallback((photo) => {
    onPhotoSelect(photo);
    onClose();
  }, [onPhotoSelect, onClose]);
  
  const handleYearChange = useCallback((newYear) => {
    setCurrentYear(newYear);
  }, []);
  
  // Close on escape key
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (selectedDay) {
          setSelectedDay(null);
        } else {
          onClose();
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedDay, onClose]);
  
  return (
    <div className="calendar-overlay" onClick={onClose}>
      <div className={`calendar-container ${selectedDay ? 'with-day-view' : ''}`} onClick={(e) => e.stopPropagation()}>
        <button className="calendar-close-btn" onClick={onClose} title="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
        
        <div className="calendar-split-view">
          <YearView
            year={currentYear}
            photosByDay={photosByDay}
            maxCount={maxCount}
            onDayClick={handleDayClick}
            onYearChange={handleYearChange}
            selectedDay={selectedDay}
            isCompact={!!selectedDay}
          />
          
          {selectedDay && (
            <DayDetailView
              selectedDay={selectedDay}
              photosByHour={photosByHour}
              onClose={handleBack}
              onPhotoClick={handlePhotoClick}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(CalendarOverlay);
